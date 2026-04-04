import { randomUUID } from "node:crypto";

import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { createOpencode, type OpencodeClient, type Event as OpencodeEvent } from "@opencode-ai/sdk";
import { Effect, Layer, Queue, Random, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "opencode" as const;

// ── Pending request tracking ──────────────────────────────────────────

interface PendingPermissionRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly permissionId: string;
}

interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface ActiveOpencodeSession {
  readonly client: OpencodeClient;
  readonly serverClose: () => void;
  readonly serverUrl: string;
  readonly opencodeSessionId: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly pendingPermissions: Map<string, PendingPermissionRequest>;
  readonly turns: Array<MutableTurnSnapshot>;
  sseAbortController: AbortController | null;
  cwd: string | undefined;
  model: string | undefined;
  providerID: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
}

export interface OpencodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value ? RuntimeItemId.makeUnsafe(value) : undefined;
}

function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value ? RuntimeRequestId.makeUnsafe(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value ? ProviderItemId.makeUnsafe(value) : undefined;
}

function isOpencodeModelSelection(
  value: unknown,
): value is Extract<
  NonNullable<ProviderSendTurnInput["modelSelection"]>,
  { provider: "opencode" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "opencode" &&
    "model" in value &&
    typeof value.model === "string"
  );
}

function approvalDecisionToOpencodeResponse(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

/**
 * Map OpenCode permission metadata to our request type taxonomy.
 */
function requestTypeFromPermission(permission: {
  metadata?: Record<string, unknown>;
}): PendingPermissionRequest["requestType"] {
  const meta = permission.metadata;
  if (!meta) return "unknown";
  const tool = typeof meta.tool === "string" ? meta.tool : undefined;
  if (tool?.includes("bash") || tool?.includes("shell") || tool?.includes("exec")) {
    return "command_execution_approval";
  }
  if (tool?.includes("write") || tool?.includes("edit") || tool?.includes("patch")) {
    return "file_change_approval";
  }
  if (tool?.includes("read") || tool?.includes("glob") || tool?.includes("grep")) {
    return "file_read_approval";
  }
  return "dynamic_tool_call";
}

function requestDetailFromPermission(permission: {
  metadata?: Record<string, unknown>;
}): string | undefined {
  const meta = permission.metadata;
  if (!meta) return undefined;
  return (
    normalizeString(meta.description) ??
    normalizeString(meta.command) ??
    normalizeString(meta.tool) ??
    normalizeString(meta.path)
  );
}

function buildThreadSnapshot(
  threadId: ThreadId,
  turns: ReadonlyArray<MutableTurnSnapshot>,
): ProviderThreadSnapshot {
  return {
    threadId,
    turns: turns.map<ProviderThreadTurnSnapshot>((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

function eventBase(input: {
  eventId: EventId;
  createdAt: string;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = normalizeString(input.requestId);

  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}

// ── Adapter implementation ────────────────────────────────────────────

const makeOpencodeAdapter = Effect.fn("makeOpencodeAdapter")(function* (
  options?: OpencodeAdapterLiveOptions,
) {
  const _serverConfig = yield* ServerConfig;
  const _serverSettings = yield* ServerSettingsService;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const sessions = new Map<ThreadId, ActiveOpencodeSession>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () =>
    Effect.all({
      eventId: nextEventId,
      createdAt: Effect.sync(() => new Date().toISOString()),
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActiveOpencodeSession, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const emit = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const logNativeEvent = Effect.fn("logNativeEvent")(function* (
    threadId: ThreadId,
    event: OpencodeEvent,
  ) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(
      {
        observedAt: new Date().toISOString(),
        event,
      },
      threadId,
    );
  });

  const makeSyntheticEvent = <TType extends ProviderRuntimeEvent["type"]>(
    threadId: ThreadId,
    type: TType,
    payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      return {
        ...eventBase({
          eventId: stamp.eventId,
          createdAt: stamp.createdAt,
          threadId,
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          ...(extra?.itemId ? { itemId: extra.itemId } : {}),
          ...(extra?.requestId ? { requestId: extra.requestId } : {}),
          raw: {
            source: "opencode.sdk.synthetic",
            payload,
          },
        }),
        type,
        payload,
      } as Extract<ProviderRuntimeEvent, { type: TType }>;
    });

  /**
   * Map an OpenCode SSE event to zero or more ProviderRuntimeEvents.
   */
  const mapEvent = (
    session: ActiveOpencodeSession,
    event: OpencodeEvent,
  ): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> =>
    Effect.gen(function* () {
      const turnId = session.activeTurnId;
      const stamp = yield* makeEventStamp();
      const createdAt = stamp.createdAt;
      const raw = {
        source: "opencode.sdk.session-event" as const,
        method: event.type,
        payload: event,
      };

      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties.part;
          const delta = event.properties.delta;

          if (part.type === "text" && delta) {
            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  itemId: part.id,
                  raw,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta,
                },
              },
            ];
          }

          if (part.type === "tool") {
            // Tool call progress — map to item.started on first delta, item.completed when done
            const toolPart = part as unknown as {
              id: string;
              type: "tool";
              tool: string;
              state: string;
              input?: unknown;
              output?: string;
              error?: string;
            };

            if (toolPart.state === "pending" || toolPart.state === "running") {
              return [
                {
                  ...eventBase({
                    eventId: stamp.eventId,
                    createdAt,
                    threadId: session.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId: toolPart.id,
                    raw,
                  }),
                  type: "item.started",
                  payload: {
                    itemType: "dynamic_tool_call",
                    status: "inProgress",
                    title: toolPart.tool,
                    ...(toolPart.input ? { data: toolPart.input } : {}),
                  },
                },
              ];
            }

            if (toolPart.state === "completed" || toolPart.state === "error") {
              return [
                {
                  ...eventBase({
                    eventId: stamp.eventId,
                    createdAt,
                    threadId: session.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId: toolPart.id,
                    raw,
                  }),
                  type: "item.completed",
                  payload: {
                    itemType: "dynamic_tool_call",
                    status: toolPart.state === "completed" ? "completed" : "failed",
                    title: toolPart.tool,
                    ...(toolPart.output ? { detail: toolPart.output } : {}),
                    ...(toolPart.error ? { detail: toolPart.error } : {}),
                    data: toolPart,
                  },
                },
              ];
            }

            return [];
          }

          if (part.type === "reasoning" && delta) {
            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  itemId: part.id,
                  raw,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "reasoning_text",
                  delta,
                },
              },
            ];
          }

          return [];
        }

        case "message.updated": {
          const msg = event.properties.info;
          if (msg.role !== "assistant") return [];

          const assistantMsg = msg as {
            id: string;
            role: "assistant";
            modelID?: string;
            providerID?: string;
            tokens?: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            };
            cost?: number;
            time?: { completed?: number };
          };

          // Track model info
          if (assistantMsg.modelID) {
            session.model = assistantMsg.modelID;
          }
          if (assistantMsg.providerID) {
            session.providerID = assistantMsg.providerID;
          }

          // Emit token usage if available
          if (assistantMsg.tokens) {
            const tokens = assistantMsg.tokens;
            const inputTokens = tokens.input ?? 0;
            const outputTokens = tokens.output ?? 0;
            const cachedInputTokens = tokens.cache?.read ?? 0;
            const usedTokens = inputTokens + outputTokens + cachedInputTokens;

            if (usedTokens > 0) {
              const usage: ThreadTokenUsageSnapshot = {
                usedTokens,
                totalProcessedTokens: usedTokens,
                ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
                ...(cachedInputTokens > 0
                  ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
                  : {}),
                ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
                ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
              };
              session.lastUsage = usage;

              return [
                {
                  ...eventBase({
                    eventId: stamp.eventId,
                    createdAt,
                    threadId: session.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId: assistantMsg.id,
                    raw,
                  }),
                  type: "thread.token-usage.updated",
                  payload: { usage },
                },
              ];
            }
          }

          // If the message is complete (has completion time), emit item.completed
          if (assistantMsg.time?.completed) {
            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  itemId: assistantMsg.id,
                  raw,
                }),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                  data: assistantMsg,
                },
              },
            ];
          }

          return [];
        }

        case "session.status": {
          const status = event.properties.status;

          if (status.type === "busy") {
            // Turn started
            const newTurnId = TurnId.makeUnsafe(`opencode-turn-${randomUUID()}`);
            session.activeTurnId = newTurnId;
            session.turns.push({ id: newTurnId, items: [event] });

            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  turnId: newTurnId,
                  raw,
                }),
                type: "turn.started",
                payload: session.model ? { model: session.model } : {},
              },
            ];
          }

          if (status.type === "idle") {
            // Turn completed
            const completedTurnId = turnId;
            session.activeTurnId = undefined;
            session.turns.at(-1)?.items.push(event);

            const readyEventId = yield* nextEventId;
            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(completedTurnId ? { turnId: completedTurnId } : {}),
                  raw,
                }),
                type: "turn.completed",
                payload: {
                  state: "completed",
                  ...(session.lastUsage ? { usage: session.lastUsage } : {}),
                },
              },
              {
                ...eventBase({
                  eventId: readyEventId,
                  createdAt,
                  threadId: session.threadId,
                  raw,
                }),
                type: "session.state.changed",
                payload: { state: "ready", reason: "session.idle" },
              },
            ];
          }

          return [];
        }

        case "permission.updated": {
          const permission = event.properties as {
            id: string;
            sessionID: string;
            metadata?: Record<string, unknown>;
          };

          if (!session.pendingPermissions.has(permission.id)) {
            const reqType = requestTypeFromPermission(permission);
            session.pendingPermissions.set(permission.id, {
              requestType: reqType,
              turnId,
              permissionId: permission.id,
            });

            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  requestId: permission.id,
                  raw,
                }),
                type: "request.opened",
                payload: {
                  requestType: reqType,
                  ...(requestDetailFromPermission(permission)
                    ? { detail: requestDetailFromPermission(permission) }
                    : {}),
                  args: permission,
                },
              },
            ];
          }
          return [];
        }

        case "session.error": {
          const errProps = event.properties as {
            sessionID?: string;
            error?: { type?: string; message?: string };
          };
          const errorMessage =
            errProps.error?.message ?? errProps.error?.type ?? "Unknown OpenCode error";
          session.lastError = errorMessage;

          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "runtime.error",
              payload: {
                message: errorMessage,
                class: "provider_error",
                detail: errProps.error,
              },
            },
          ];
        }

        default:
          return [];
      }
    });

  const handleEvent = Effect.fn("handleEvent")(function* (
    session: ActiveOpencodeSession,
    event: OpencodeEvent,
  ) {
    session.updatedAt = new Date().toISOString();

    // Append to current turn snapshot
    if (session.turns.length > 0) {
      session.turns.at(-1)?.items.push(event);
    }

    yield* logNativeEvent(session.threadId, event);
    const mapped = yield* mapEvent(session, event);
    if (mapped.length > 0) {
      yield* emit(mapped);
    }
  });

  /**
   * Start the SSE event stream for a session.
   * Runs in the background, piping events until the abort controller fires.
   */
  function startEventStream(session: ActiveOpencodeSession): void {
    const abortController = new AbortController();
    session.sseAbortController = abortController;

    void (async () => {
      try {
        const { stream } = await session.client.event.subscribe();
        for await (const event of stream) {
          if (abortController.signal.aborted) break;

          // Filter events to only those for this session
          const props = event.properties as Record<string, unknown>;
          const eventSessionId =
            (props.sessionID as string | undefined) ??
            (props.info as Record<string, unknown> | undefined)?.sessionID;

          if (eventSessionId && eventSessionId !== session.opencodeSessionId) {
            continue;
          }

          await handleEvent(session, event)
            .pipe(Effect.runPromise)
            .catch(() => undefined);
        }
      } catch {
        // SSE stream ended or errored — this is expected on session stop
      }
    })();
  }

  // ── Adapter methods ──────────────────────────────────────────────

  const startSession: OpencodeAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing) {
        return {
          provider: PROVIDER,
          status: existing.activeTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          threadId: input.threadId,
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          resumeCursor: { sessionId: existing.opencodeSessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      // Start OpenCode server via createOpencode()
      const { client, server } = yield* Effect.tryPromise({
        try: () => createOpencode(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start OpenCode server."),
            cause,
          }),
      });

      // Determine model to use
      let modelID: string | undefined;
      let providerID: string | undefined;
      if (isOpencodeModelSelection(input.modelSelection)) {
        modelID = input.modelSelection.model;
        // Try to find the provider for this model from the config
        const resolved = yield* Effect.tryPromise({
          try: async () => {
            const providersResp = await client.config.providers();
            if (providersResp.data) {
              for (const p of providersResp.data.providers) {
                if (p.models && modelID && modelID in p.models) {
                  return p.id;
                }
              }
            }
            return undefined;
          },
          catch: () => undefined as never,
        }).pipe(Effect.orElseSucceed(() => undefined));
        providerID = resolved;
      }

      // Create an OpenCode session
      const sessionResp = yield* Effect.tryPromise({
        try: () =>
          client.session.create({
            body: input.cwd ? { title: `T3 Code session in ${input.cwd}` } : {},
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to create OpenCode session."),
            cause,
          }),
      });

      if (sessionResp.error || !sessionResp.data) {
        server.close();
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: `Failed to create OpenCode session: ${String(sessionResp.error)}`,
        });
      }

      const opencodeSessionId = sessionResp.data.id;
      const createdAt = new Date().toISOString();

      const record: ActiveOpencodeSession = {
        client,
        serverClose: () => server.close(),
        serverUrl: server.url,
        opencodeSessionId,
        threadId: input.threadId,
        createdAt,
        runtimeMode: input.runtimeMode,
        pendingPermissions: new Map(),
        turns: [],
        sseAbortController: null,
        cwd: input.cwd,
        model: modelID,
        providerID,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        lastUsage: undefined,
      };

      sessions.set(input.threadId, record);

      // Start the SSE event stream
      startEventStream(record);

      yield* emit([
        yield* makeSyntheticEvent(
          input.threadId,
          "session.started",
          input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        ),
        yield* makeSyntheticEvent(input.threadId, "thread.started", {
          providerThreadId: opencodeSessionId,
        }),
        yield* makeSyntheticEvent(input.threadId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelID ? { model: modelID } : {}),
        resumeCursor: { sessionId: opencodeSessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    });

  const sendTurn: OpencodeAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireSession(input.threadId);

      if (isOpencodeModelSelection(input.modelSelection)) {
        record.model = input.modelSelection.model;
      }

      const turnId = TurnId.makeUnsafe(`opencode-turn-${randomUUID()}`);
      record.activeTurnId = turnId;
      record.updatedAt = new Date().toISOString();

      // Use promptAsync for non-blocking send with SSE streaming
      yield* Effect.tryPromise({
        try: () =>
          record.client.session.promptAsync({
            path: { id: record.opencodeSessionId },
            body: {
              parts: [{ type: "text", text: input.input ?? "" }],
              ...(record.model
                ? {
                    model: {
                      providerID: record.providerID ?? "",
                      modelID: record.model,
                    },
                  }
                : {}),
            },
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.promptAsync",
            detail: toMessage(cause, "Failed to send OpenCode turn."),
            cause,
          }),
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: record.opencodeSessionId },
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: OpencodeAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () =>
          record.client.session.abort({
            path: { id: record.opencodeSessionId },
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.abort",
            detail: toMessage(cause, "Failed to interrupt OpenCode turn."),
            cause,
          }),
      });
    });

  const respondToRequest: OpencodeAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingPermissions.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.permission.respond",
          detail: `Unknown pending OpenCode permission request '${requestId}'.`,
        });
      }

      record.pendingPermissions.delete(requestId);

      // Respond via the OpenCode SDK permission API
      yield* Effect.tryPromise({
        try: () =>
          record.client.postSessionIdPermissionsPermissionId({
            path: {
              id: record.opencodeSessionId,
              permissionID: pending.permissionId,
            },
            body: {
              response: approvalDecisionToOpencodeResponse(decision),
            },
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.permission.respond",
            detail: toMessage(cause, "Failed to respond to OpenCode permission request."),
            cause,
          }),
      });

      const event = yield* makeSyntheticEvent(
        threadId,
        "request.resolved",
        {
          requestType: pending.requestType,
          decision,
        },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emit([event]);
    });

  const respondToUserInput: OpencodeAdapterShape["respondToUserInput"] = (
    threadId,
    _requestId,
    _answers,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session.userInput.respond",
        detail: "OpenCode does not support interactive user-input requests.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

  const stopSessionRecord = (record: ActiveOpencodeSession) =>
    Effect.tryPromise({
      try: async () => {
        // Abort SSE stream
        record.sseAbortController?.abort();
        record.sseAbortController = null;

        // Clear pending permissions
        record.pendingPermissions.clear();

        // Delete the session from OpenCode
        try {
          await record.client.session.delete({
            path: { id: record.opencodeSessionId },
          });
        } catch {
          // Best effort — session might already be gone
        }

        // Shut down the OpenCode server
        record.serverClose();
        sessions.delete(record.threadId);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.stop",
          detail: toMessage(cause, "Failed to stop OpenCode session."),
          cause,
        }),
    });

  const stopSession: OpencodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      yield* stopSessionRecord(record);
    });

  const listSessions: OpencodeAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values()).map((record) => {
        return Object.assign(
          {
            provider: PROVIDER,
            status: record.activeTurnId ? ("running" as const) : ("ready" as const),
            runtimeMode: record.runtimeMode,
            threadId: record.threadId,
            resumeCursor: { sessionId: record.opencodeSessionId },
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
          record.cwd ? { cwd: record.cwd } : undefined,
          record.model ? { model: record.model } : undefined,
          record.activeTurnId ? { activeTurnId: record.activeTurnId } : undefined,
          record.lastError ? { lastError: record.lastError } : undefined,
        ) satisfies ProviderSession;
      }),
    );

  const hasSession: OpencodeAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: OpencodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      return buildThreadSnapshot(threadId, record.turns);
    });

  const rollbackThread: OpencodeAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "OpenCode sessions do not support rolling back conversation state.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

  const stopAll: OpencodeAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionRecord, {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OpencodeAdapterShape;
});

export const OpencodeAdapterLive = Layer.effect(OpencodeAdapter, makeOpencodeAdapter());

export function makeOpencodeAdapterLive(options?: OpencodeAdapterLiveOptions) {
  return Layer.effect(OpencodeAdapter, makeOpencodeAdapter(options));
}
