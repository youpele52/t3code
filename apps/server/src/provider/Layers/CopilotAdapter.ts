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
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type MessageOptions,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect, Layer, Queue, Random, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "copilot" as const;
const DEFAULT_BINARY_PATH = "copilot";
const USER_INPUT_QUESTION_ID = "answer";

interface PendingApprovalRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

interface PendingUserInputRequest {
  readonly turnId: TurnId | undefined;
  readonly choices: ReadonlyArray<string>;
  readonly resolve: (result: CopilotUserInputResponse) => void;
}

interface CopilotUserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

interface CopilotUserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface ActiveCopilotSession {
  readonly client: CopilotClient;
  readonly session: CopilotSession;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly turns: Array<MutableTurnSnapshot>;
  unsubscribe: () => void;
  cwd: string | undefined;
  model: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  activeMessageId: string | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
}

export interface CopilotAdapterLiveOptions {
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClient;
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

function isCopilotModelSelection(
  value: unknown,
): value is Extract<NonNullable<ProviderSendTurnInput["modelSelection"]>, { provider: "copilot" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "copilot" &&
    "model" in value &&
    typeof value.model === "string"
  );
}

function approvalDecisionToPermissionResult(
  decision: ProviderApprovalDecision,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "mcp":
    case "custom-tool":
    case "url":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return normalizeString(request.fullCommandText);
    case "write":
      return normalizeString(request.fileName) ?? normalizeString(request.intention);
    case "read":
      return normalizeString(request.path) ?? normalizeString(request.intention);
    case "mcp":
      return normalizeString(request.toolTitle) ?? normalizeString(request.toolName);
    case "url":
      return normalizeString(request.url);
    case "custom-tool":
      return normalizeString(request.toolName) ?? normalizeString(request.toolDescription);
    default:
      return undefined;
  }
}

function normalizeUsage(
  event: Extract<SessionEvent, { type: "assistant.usage" }>,
): ThreadTokenUsageSnapshot {
  const inputTokens = event.data.inputTokens ?? 0;
  const outputTokens = event.data.outputTokens ?? 0;
  const cachedInputTokens = event.data.cacheReadTokens ?? 0;
  const usedTokens = inputTokens + outputTokens + cachedInputTokens;

  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
    ...(typeof event.data.duration === "number" ? { durationMs: event.data.duration } : {}),
  };
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

const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  options?: CopilotAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const sessions = new Map<ThreadId, ActiveCopilotSession>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () =>
    Effect.all({
      eventId: nextEventId,
      createdAt: Effect.sync(() => new Date().toISOString()),
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const emit = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const logNativeEvent = Effect.fn("logNativeEvent")(function* (
    threadId: ThreadId,
    event: SessionEvent,
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
            source: "copilot.sdk.synthetic",
            payload,
          },
        }),
        type,
        payload,
      } as Extract<ProviderRuntimeEvent, { type: TType }>;
    });

  const mapEvent = (
    session: ActiveCopilotSession,
    event: SessionEvent,
  ): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> =>
    Effect.gen(function* () {
      const turnId = session.activeTurnId;
      const stamp = yield* makeEventStamp();
      const raw = {
        source: "copilot.sdk.session-event" as const,
        method: event.type,
        payload: event,
      };

      switch (event.type) {
        case "assistant.turn_start": {
          const eventTurnId = TurnId.makeUnsafe(event.data.turnId);
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                turnId: eventTurnId,
                raw,
              }),
              type: "turn.started",
              payload: session.model ? { model: session.model } : {},
            },
          ];
        }
        case "assistant.message_delta":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                itemId: event.data.messageId,
                raw,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: event.data.deltaContent,
              },
            },
          ];
        case "assistant.message":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                itemId: event.data.messageId,
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                detail: event.data.content,
                data: event.data,
              },
            },
          ];
        case "assistant.usage":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "thread.token-usage.updated",
              payload: { usage: normalizeUsage(event) },
            },
          ];
        case "session.idle": {
          const readyEventId = yield* nextEventId;
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "turn.completed",
              payload: {
                state: event.data.aborted ? "interrupted" : "completed",
                ...(session.lastUsage ? { usage: session.lastUsage } : {}),
              },
            },
            {
              ...eventBase({
                eventId: readyEventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                raw,
              }),
              type: "session.state.changed",
              payload: { state: "ready", reason: "session.idle" },
            },
          ];
        }
        case "abort":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "turn.aborted",
              payload: { reason: event.data.reason },
            },
          ];
        case "session.error":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "runtime.error",
              payload: {
                message: event.data.message,
                class: "provider_error",
                detail: event.data,
              },
            },
          ];
        case "tool.execution_start":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                itemId: event.data.toolCallId,
                raw,
              }),
              type: "item.started",
              payload: {
                itemType: event.data.mcpToolName ? "mcp_tool_call" : "dynamic_tool_call",
                status: "inProgress",
                title: event.data.toolName,
                ...(event.data.arguments ? { data: event.data.arguments } : {}),
              },
            },
          ];
        case "tool.execution_complete":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                itemId: event.data.toolCallId,
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "dynamic_tool_call",
                status: event.data.success ? "completed" : "failed",
                title: "Tool call",
                ...((event.data.result?.detailedContent ?? event.data.result?.content)
                  ? { detail: event.data.result?.detailedContent ?? event.data.result?.content }
                  : {}),
                data: event.data,
              },
            },
          ];
        case "user_input.requested": {
          const question: UserInputQuestion = {
            id: USER_INPUT_QUESTION_ID,
            header: "Question",
            question: event.data.question,
            options: (event.data.choices ?? []).map((choice: string) => ({
              label: choice,
              description: choice,
            })),
          };
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                requestId: event.data.requestId,
                raw,
              }),
              type: "user-input.requested",
              payload: { questions: [question] },
            },
          ];
        }
        case "user_input.completed":
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt: event.timestamp,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                requestId: event.data.requestId,
                raw,
              }),
              type: "user-input.resolved",
              payload: { answers: {} },
            },
          ];
        default:
          return [];
      }
    });

  const handleEvent = Effect.fn("handleEvent")(function* (
    session: ActiveCopilotSession,
    event: SessionEvent,
  ) {
    session.updatedAt = event.timestamp;

    if (event.type === "assistant.turn_start") {
      const turnId = TurnId.makeUnsafe(event.data.turnId);
      session.activeTurnId = turnId;
      session.turns.push({ id: turnId, items: [event] });
    } else if (event.type === "assistant.message") {
      session.activeMessageId = event.data.messageId;
      session.turns.at(-1)?.items.push(event);
    } else if (
      event.type === "assistant.message_delta" ||
      event.type === "assistant.usage" ||
      event.type === "tool.execution_start" ||
      event.type === "tool.execution_complete" ||
      event.type === "user_input.requested" ||
      event.type === "user_input.completed"
    ) {
      session.turns.at(-1)?.items.push(event);
    } else if (
      event.type === "session.idle" ||
      event.type === "abort" ||
      event.type === "assistant.turn_end" ||
      event.type === "session.error"
    ) {
      session.turns.at(-1)?.items.push(event);
      if (event.type === "session.idle" || event.type === "abort") {
        session.activeTurnId = undefined;
        session.activeMessageId = undefined;
      }
    }

    if (event.type === "assistant.usage") {
      session.lastUsage = normalizeUsage(event);
    }

    if (event.type === "session.error") {
      session.lastError = event.data.message;
    }

    yield* logNativeEvent(session.threadId, event);
    const mapped = yield* mapEvent(session, event);
    if (mapped.length > 0) {
      yield* emit(mapped);
    }
  });

  const buildSessionConfig = (
    input: {
      threadId: ThreadId;
      runtimeMode: ProviderSession["runtimeMode"];
      cwd?: string;
      modelSelection?: ProviderSendTurnInput["modelSelection"] | ProviderSession["resumeCursor"];
    },
    pendingApprovals: Map<string, PendingApprovalRequest>,
    pendingUserInputs: Map<string, PendingUserInputRequest>,
    activeTurnId: () => TurnId | undefined,
  ): SessionConfig => ({
    ...(isCopilotModelSelection(input.modelSelection)
      ? {
          model: input.modelSelection.model,
          ...(input.modelSelection.options?.reasoningEffort
            ? { reasoningEffort: input.modelSelection.options.reasoningEffort }
            : {}),
        }
      : {}),
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    streaming: true,
    onPermissionRequest: (request) => {
      if (input.runtimeMode === "full-access") {
        return { kind: "approved" };
      }

      return new Promise<PermissionRequestResult>((resolve) => {
        const requestId = randomUUID();
        const currentTurnId = activeTurnId();
        pendingApprovals.set(requestId, {
          requestType: requestTypeFromPermissionRequest(request),
          turnId: currentTurnId,
          resolve,
        });

        void makeSyntheticEvent(
          input.threadId,
          "request.opened",
          {
            requestType: requestTypeFromPermissionRequest(request),
            ...(requestDetailFromPermissionRequest(request)
              ? { detail: requestDetailFromPermissionRequest(request) }
              : {}),
            args: request,
          },
          {
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            requestId,
          },
        )
          .pipe(
            Effect.flatMap((event) => emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);
      });
    },
    onUserInputRequest: (request: CopilotUserInputRequest, _invocation) =>
      new Promise<CopilotUserInputResponse>((resolve) => {
        const requestId = randomUUID();
        const currentTurnId = activeTurnId();
        pendingUserInputs.set(requestId, {
          turnId: currentTurnId,
          choices: request.choices ?? [],
          resolve,
        });

        const question: UserInputQuestion = {
          id: USER_INPUT_QUESTION_ID,
          header: "Question",
          question: request.question,
          options: (request.choices ?? []).map((choice: string) => ({
            label: choice,
            description: choice,
          })),
        };

        void makeSyntheticEvent(
          input.threadId,
          "user-input.requested",
          { questions: [question] },
          {
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            requestId,
          },
        )
          .pipe(
            Effect.flatMap((event) => emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);
      }),
  });

  const startSession: CopilotAdapterShape["startSession"] = (input) =>
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
          resumeCursor: { sessionId: existing.session.sessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      const copilotSettings = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      );
      const useCustomBinary = copilotSettings.binaryPath !== DEFAULT_BINARY_PATH;
      const clientOptions: CopilotClientOptions = {
        ...(useCustomBinary ? { cliPath: copilotSettings.binaryPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        logLevel: "error",
      };
      const client = options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
      const pendingApprovals = new Map<string, PendingApprovalRequest>();
      const pendingUserInputs = new Map<string, PendingUserInputRequest>();
      let activeTurn: TurnId | undefined;
      const sessionConfig = buildSessionConfig(
        {
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        },
        pendingApprovals,
        pendingUserInputs,
        () => activeTurn,
      );

      const session = yield* Effect.tryPromise({
        try: () => {
          const sessionId =
            typeof input.resumeCursor === "object" &&
            input.resumeCursor !== null &&
            "sessionId" in input.resumeCursor &&
            typeof input.resumeCursor.sessionId === "string"
              ? input.resumeCursor.sessionId
              : undefined;
          return sessionId
            ? client.resumeSession(sessionId, sessionConfig)
            : client.createSession(sessionConfig);
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start GitHub Copilot session."),
            cause,
          }),
      });

      const createdAt = new Date().toISOString();
      const record: ActiveCopilotSession = {
        client,
        session,
        threadId: input.threadId,
        createdAt,
        runtimeMode: input.runtimeMode,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        unsubscribe: () => {},
        cwd: input.cwd,
        model:
          input.modelSelection?.provider === "copilot" ? input.modelSelection.model : undefined,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        activeMessageId: undefined,
        lastUsage: undefined,
      };

      record.unsubscribe = session.on((event) => {
        activeTurn =
          event.type === "assistant.turn_start" ? TurnId.makeUnsafe(event.data.turnId) : activeTurn;
        void handleEvent(record, event)
          .pipe(Effect.runPromise)
          .catch(() => undefined);
        activeTurn = record.activeTurnId;
      });

      sessions.set(input.threadId, record);

      yield* emit([
        yield* makeSyntheticEvent(
          input.threadId,
          "session.started",
          input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        ),
        yield* makeSyntheticEvent(input.threadId, "thread.started", {
          providerThreadId: session.sessionId,
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
        ...(record.model ? { model: record.model } : {}),
        resumeCursor: { sessionId: session.sessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    });

  const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireSession(input.threadId);
      const attachments: MessageOptions["attachments"] = (input.attachments ?? []).map(
        (attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          return {
            type: "file" as const,
            path,
            displayName: attachment.name,
          };
        },
      );

      const copilotModelSelection =
        input.modelSelection?.provider === "copilot" ? input.modelSelection : undefined;

      if (copilotModelSelection) {
        record.model = copilotModelSelection.model;

        yield* Effect.tryPromise({
          try: () =>
            record.session.setModel(
              copilotModelSelection.model,
              copilotModelSelection.options?.reasoningEffort
                ? { reasoningEffort: copilotModelSelection.options.reasoningEffort }
                : undefined,
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.setModel",
              detail: toMessage(cause, "Failed to apply GitHub Copilot model selection."),
              cause,
            }),
        });
      }

      const turnId = TurnId.makeUnsafe(`copilot-turn-${randomUUID()}`);
      record.activeTurnId = turnId;
      record.updatedAt = new Date().toISOString();

      yield* Effect.tryPromise({
        try: () =>
          record.session.send({
            prompt: input.input ?? "",
            ...(attachments.length > 0 ? { attachments } : {}),
            mode: "immediate",
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.send",
            detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
            cause,
          }),
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: record.session.sessionId },
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => record.session.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.abort",
            detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
            cause,
          }),
      });
    });

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.permission.respond",
          detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
        });
      }

      record.pendingApprovals.delete(requestId);
      pending.resolve(approvalDecisionToPermissionResult(decision));
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

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.userInput.respond",
          detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
        });
      }

      record.pendingUserInputs.delete(requestId);
      const candidate =
        typeof answers[USER_INPUT_QUESTION_ID] === "string"
          ? answers[USER_INPUT_QUESTION_ID]
          : (Object.values(answers).find((value): value is string => typeof value === "string") ??
            "");
      pending.resolve({
        answer: candidate,
        wasFreeform: !pending.choices.includes(candidate),
      });

      const event = yield* makeSyntheticEvent(
        threadId,
        "user-input.resolved",
        { answers },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emit([event]);
    });

  const stopSessionRecord = (record: ActiveCopilotSession) =>
    Effect.tryPromise({
      try: async () => {
        record.unsubscribe();
        for (const pending of record.pendingApprovals.values()) {
          pending.resolve({ kind: "denied-interactively-by-user" });
        }
        for (const pending of record.pendingUserInputs.values()) {
          pending.resolve({ answer: "", wasFreeform: true });
        }
        record.pendingApprovals.clear();
        record.pendingUserInputs.clear();
        await record.session.disconnect();
        await record.client.stop();
        sessions.delete(record.threadId);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.stop",
          detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
          cause,
        }),
    });

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      yield* stopSessionRecord(record);
    });

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values()).map((record) => {
        return Object.assign(
          {
            provider: PROVIDER,
            status: record.activeTurnId ? ("running" as const) : ("ready" as const),
            runtimeMode: record.runtimeMode,
            threadId: record.threadId,
            resumeCursor: { sessionId: record.session.sessionId },
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

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      return buildThreadSnapshot(threadId, record.turns);
    });

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "GitHub Copilot sessions do not support rolling back conversation state.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionRecord, {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
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
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
