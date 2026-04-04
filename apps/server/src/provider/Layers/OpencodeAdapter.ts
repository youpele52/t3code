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
import { type OpencodeClient, type Event as OpencodeEvent } from "@opencode-ai/sdk";
import { Effect, Layer, Queue, Random, Stream } from "effect";

import { OpencodeServerManager } from "../Services/OpencodeServerManager.ts";

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
  /** Releases the shared server handle acquired from OpencodeServerManager. */
  readonly releaseServer: () => void;
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

function withOpencodeDirectory<T extends object>(
  cwd: string | undefined,
  input: T,
):
  | T
  | (T & {
      query: { directory: string };
    }) {
  return cwd ? { ...input, query: { directory: cwd } } : input;
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
  const serverManager = yield* OpencodeServerManager;

  // Capture the Effect services context so we can run effects from
  // non-Effect code (e.g. the SSE event loop).  This mirrors the
  // pattern used by CodexAdapter (see registerListener).
  const services = yield* Effect.services<never>();

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
      const eventType = (event as { type: string }).type;
      const raw = {
        source: "opencode.sdk.session-event" as const,
        method: eventType,
        payload: event,
      };

      if (eventType === "message.part.delta") {
        const partDelta = event as OpencodeEvent & {
          properties: {
            partID?: string;
            field?: string;
            delta?: string;
          };
        };
        const delta = partDelta.properties.delta;
        const itemId = partDelta.properties.partID;

        if (!delta || !itemId) {
          return [];
        }

        const streamKind =
          partDelta.properties.field === "text"
            ? "assistant_text"
            : partDelta.properties.field === "reasoning"
              ? "reasoning_text"
              : undefined;

        if (!streamKind) {
          return [];
        }

        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind,
              delta,
            },
          },
        ];
      }

      switch (eventType) {
        case "message.part.updated": {
          const part = (event.properties as { part: { id: string; type: string } }).part;
          if (part.type === "tool") {
            // Tool call progress — map to item.started on first delta, item.completed when done
            const toolPart = part as unknown as {
              id: string;
              type: "tool";
              tool: string;
              state: {
                status?: string;
                input?: unknown;
                output?: string;
                error?: string;
                metadata?: Record<string, unknown>;
                title?: string;
              };
              metadata?: Record<string, unknown>;
            };

            const toolState = toolPart.state?.status;
            const toolInput = toolPart.state?.input;
            const toolOutput = normalizeString(toolPart.state?.output);
            const toolError = normalizeString(toolPart.state?.error);
            const toolTitle =
              normalizeString(toolPart.state?.title) ??
              normalizeString(toolPart.metadata?.title) ??
              toolPart.tool;

            if (toolState === "pending" || toolState === "running") {
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
                    title: toolTitle,
                    ...(toolInput ? { data: toolInput } : {}),
                  },
                },
              ];
            }

            if (toolState === "completed" || toolState === "error") {
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
                    status: toolState === "completed" ? "completed" : "failed",
                    title: toolTitle,
                    ...(toolOutput ? { detail: toolOutput } : {}),
                    ...(toolError ? { detail: toolError } : {}),
                    data: toolPart,
                  },
                },
              ];
            }

            return [];
          }

          return [];
        }
        case "message.updated": {
          const msg = (event.properties as { info: { role: string } }).info;
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
          const status = (event.properties as { status: { type: string } }).status;

          if (status.type === "busy") {
            // If sendTurn already set an activeTurnId, reuse it (avoids
            // double-TurnId creation).  Only mint a fresh id for
            // server-initiated turns (e.g. retries, auto-continuations).
            const existingTurnId = session.activeTurnId;
            if (existingTurnId) {
              // Turn was already started by sendTurn — just append the
              // event to the existing turn snapshot.  No new
              // `turn.started` event is needed because sendTurn already
              // emitted one.
              session.turns.at(-1)?.items.push(event);
              return [];
            }

            // Server-initiated turn — create a new TurnId
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
        const { stream } = await session.client.event.subscribe(
          withOpencodeDirectory(session.cwd, {
            signal: abortController.signal,
          }),
        );
        for await (const event of stream) {
          if (abortController.signal.aborted) break;

          // Filter events to only those for this session.
          // The sessionID can live in different places depending on
          // event type, so we check several known locations.
          const props = event.properties as Record<string, unknown>;
          const eventSessionId =
            (props.sessionID as string | undefined) ??
            ((props.info as Record<string, unknown> | undefined)?.sessionID as
              | string
              | undefined) ??
            ((props.session as Record<string, unknown> | undefined)?.id as string | undefined);

          if (eventSessionId && eventSessionId !== session.opencodeSessionId) {
            continue;
          }

          await handleEvent(session, event)
            .pipe(Effect.runPromiseWith(services))
            .catch((err) => {
              console.error(
                `[opencode-adapter] handleEvent error for session=${session.opencodeSessionId} event.type=${event.type}:`,
                err,
              );
            });
        }
      } catch (err) {
        // Only log if this wasn't an intentional abort
        if (!abortController.signal.aborted) {
          console.error(
            `[opencode-adapter] SSE stream error for session=${session.opencodeSessionId}:`,
            err,
          );
          // Emit a runtime error so the UI can surface the connection issue
          makeSyntheticEvent(session.threadId, "runtime.error", {
            message: toMessage(err, "SSE event stream disconnected unexpectedly."),
            class: "transport_error",
          })
            .pipe(
              Effect.flatMap((evt) => emit([evt])),
              Effect.runPromiseWith(services),
            )
            .catch(() => {
              // Last-resort: if even emitting the error fails, just log it
              console.error(
                `[opencode-adapter] Failed to emit SSE disconnect error for session=${session.opencodeSessionId}`,
              );
            });
        }
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

      // Acquire a handle from the shared OpenCode server manager
      const serverHandle = yield* Effect.tryPromise({
        try: () => serverManager.acquire(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start OpenCode server."),
            cause,
          }),
      });
      const client = serverHandle.client;

      // Determine model to use
      let modelID: string | undefined;
      let providerID: string | undefined;
      if (isOpencodeModelSelection(input.modelSelection)) {
        modelID = input.modelSelection.model;
        // Use subProviderID from the model selection (set at enumeration time)
        // and fall back to a runtime lookup if not available.
        const selectionProviderID =
          "subProviderID" in input.modelSelection
            ? (input.modelSelection as { subProviderID?: string }).subProviderID
            : undefined;
        providerID =
          selectionProviderID ??
          (yield* Effect.tryPromise({
            try: async () => {
              const providersResp = await client.config.providers(
                withOpencodeDirectory(input.cwd, {}),
              );
              if (providersResp.data) {
                for (const p of providersResp.data.providers) {
                  if (p.models && modelID) {
                    // Check both keys and model IDs for a match
                    if (modelID in p.models) return p.id;
                    for (const m of Object.values(p.models)) {
                      if (m.id === modelID) return p.id;
                    }
                  }
                }
              }
              return undefined;
            },
            catch: () => undefined as never,
          }).pipe(Effect.orElseSucceed(() => undefined)));
      }

      // Create an OpenCode session
      const sessionResp = yield* Effect.tryPromise({
        try: () =>
          client.session.create(
            withOpencodeDirectory(input.cwd, {
              body: input.cwd ? { title: `T3 Code session in ${input.cwd}` } : {},
            }),
          ),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to create OpenCode session."),
            cause,
          }),
      });

      if (sessionResp.error || !sessionResp.data) {
        serverHandle.release();
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
        releaseServer: () => serverHandle.release(),
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
        // Use subProviderID from the model selection (set at enumeration time)
        // and fall back to a runtime lookup if not available.
        const selectionProviderID =
          "subProviderID" in input.modelSelection
            ? (input.modelSelection as { subProviderID?: string }).subProviderID
            : undefined;
        record.providerID =
          selectionProviderID ??
          (yield* Effect.tryPromise({
            try: async () => {
              const providersResp = await record.client.config.providers(
                withOpencodeDirectory(record.cwd, {}),
              );
              if (providersResp.data) {
                for (const p of providersResp.data.providers) {
                  if (p.models && record.model) {
                    // Check both keys and model IDs for a match
                    if (record.model in p.models) return p.id;
                    for (const m of Object.values(p.models)) {
                      if (m.id === record.model) return p.id;
                    }
                  }
                }
              }
              return undefined;
            },
            catch: () => undefined as never,
          }).pipe(Effect.orElseSucceed(() => undefined)));
      }

      const turnId = TurnId.makeUnsafe(`opencode-turn-${randomUUID()}`);
      record.activeTurnId = turnId;
      record.updatedAt = new Date().toISOString();
      record.turns.push({ id: turnId, items: [] });

      // Emit turn.started immediately — this is the canonical source of
      // the TurnId.  The SSE `session.status busy` handler will see that
      // activeTurnId already exists and skip creating a duplicate.
      yield* emit([
        yield* makeSyntheticEvent(
          input.threadId,
          "turn.started",
          record.model ? { model: record.model } : {},
          { turnId },
        ),
      ]);

      // Use promptAsync for non-blocking send with SSE streaming
      const promptBody = {
        parts: [{ type: "text" as const, text: input.input ?? "" }],
        ...(record.model
          ? {
              model: {
                providerID: record.providerID ?? "",
                modelID: record.model,
              },
            }
          : {}),
      };
      if (record.model && !record.providerID) {
        record.activeTurnId = undefined;
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unable to resolve OpenCode provider for model '${record.model}'.`,
        });
      }

      const promptResp = yield* Effect.tryPromise({
        try: () =>
          record.client.session.promptAsync(
            withOpencodeDirectory(record.cwd, {
              path: { id: record.opencodeSessionId },
              body: promptBody,
            }),
          ),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.promptAsync",
            detail: toMessage(cause, "Failed to send OpenCode turn."),
            cause,
          }),
      });

      if (promptResp.error) {
        record.activeTurnId = undefined;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.promptAsync",
          detail: `Failed to send OpenCode turn: ${String(promptResp.error)}`,
        });
      }

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
          record.client.session.abort(
            withOpencodeDirectory(record.cwd, {
              path: { id: record.opencodeSessionId },
            }),
          ),
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
          record.client.postSessionIdPermissionsPermissionId(
            withOpencodeDirectory(record.cwd, {
              path: {
                id: record.opencodeSessionId,
                permissionID: pending.permissionId,
              },
              body: {
                response: approvalDecisionToOpencodeResponse(decision),
              },
            }),
          ),
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
          await record.client.session.delete(
            withOpencodeDirectory(record.cwd, {
              path: { id: record.opencodeSessionId },
            }),
          );
        } catch {
          // Best effort — session might already be gone
        }

        // Release the shared server handle (decrements ref-count; shuts down server when last session stops)
        record.releaseServer();
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

      // Notify the orchestration pipeline that the session has exited
      yield* emit([
        yield* makeSyntheticEvent(threadId, "session.exited", {
          reason: "stopSession",
        }),
      ]);
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
