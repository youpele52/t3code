/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@bigcode/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CopilotProviderLive } from "./CopilotProvider";
import { CodexProviderLive } from "./CodexProvider";
import { OpencodeProviderLive } from "./OpencodeProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CopilotProviderShape } from "../Services/CopilotProvider";
import { CopilotProvider } from "../Services/CopilotProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { OpencodeProviderShape } from "../Services/OpencodeProvider";
import { OpencodeProvider } from "../Services/OpencodeProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  copilotProvider: CopilotProviderShape,
  opencodeProvider: OpencodeProviderShape,
): Effect.Effect<readonly [ServerProvider, ServerProvider, ServerProvider, ServerProvider]> =>
  Effect.all(
    [
      codexProvider.getSnapshot,
      claudeProvider.getSnapshot,
      copilotProvider.getSnapshot,
      opencodeProvider.getSnapshot,
    ],
    {
      concurrency: "unbounded",
    },
  );

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const copilotProvider = yield* CopilotProvider;
    const opencodeProvider = yield* OpencodeProvider;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadProviders(codexProvider, claudeProvider, copilotProvider, opencodeProvider),
    );

    const syncProviders = Effect.fn("syncProviders")(function* (options?: {
      readonly publish?: boolean;
    }) {
      const previousProviders = yield* Ref.get(providersRef);
      const providers = yield* loadProviders(
        codexProvider,
        claudeProvider,
        copilotProvider,
        opencodeProvider,
      );
      yield* Ref.set(providersRef, providers);

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    yield* Stream.runForEach(codexProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(claudeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(copilotProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(opencodeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex":
          yield* codexProvider.refresh;
          break;
        case "claudeAgent":
          yield* claudeProvider.refresh;
          break;
        case "copilot":
          yield* copilotProvider.refresh;
          break;
        case "opencode":
          yield* opencodeProvider.refresh;
          break;
        default:
          yield* Effect.all(
            [
              codexProvider.refresh,
              claudeProvider.refresh,
              copilotProvider.refresh,
              opencodeProvider.refresh,
            ],
            {
              concurrency: "unbounded",
            },
          );
          break;
      }
      return yield* syncProviders();
    });

    return {
      getProviders: syncProviders({ publish: false }).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => []),
      ),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CopilotProviderLive),
  Layer.provideMerge(OpencodeProviderLive),
);
