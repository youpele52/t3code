import type { ModelCapabilities, OpencodeSettings, ServerProviderModel } from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";
import { createOpencode } from "@opencode-ai/sdk";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OpencodeProvider } from "../Services/OpencodeProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ProviderAdapterProcessError } from "../Errors";

const PROVIDER = "opencode" as const;
const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

/** Fallback models when the SDK is unreachable or hasn't been configured yet. */
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: [
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: [
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
  },
];

/**
 * Map an OpenCode SDK model to a `ServerProviderModel`.
 *
 * The SDK model shape is:
 * ```ts
 * { id, name, capabilities: { reasoning, ... }, ... }
 * ```
 */
function mapOpencodeModel(model: {
  id: string;
  name: string;
  capabilities?: { reasoning?: boolean };
}): ServerProviderModel {
  const supportsReasoning = model.capabilities?.reasoning === true;
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: supportsReasoning
        ? [
            { value: "high", label: "High", isDefault: true },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ]
        : [],
    },
  };
}

/**
 * Start an OpenCode server instance via `createOpencode()`, probe health &
 * provider config, then shut it down.  Returns collected models and version.
 */
const withOpencodeServer = <A>(
  f: (client: Awaited<ReturnType<typeof createOpencode>>["client"]) => Promise<A>,
): Effect.Effect<A, ProviderAdapterProcessError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => createOpencode(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: "provider-check",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
    ({ client }) =>
      Effect.tryPromise({
        try: () => f(client),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "provider-check",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ({ server }) => Effect.sync(() => server.close()),
  );

export const checkOpencodeProviderStatus = Effect.fn("checkOpencodeProviderStatus")(function* () {
  const opencodeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.opencode),
  );
  const checkedAt = new Date().toISOString();
  const builtInModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    opencodeSettings.customModels,
  );

  if (!opencodeSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: builtInModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  const statusResult = yield* withOpencodeServer(async (client) => {
    // Fetch provider config to enumerate available models.
    const providersResp = await client.config.providers();

    if (providersResp.error) {
      throw new Error(`Failed to list OpenCode providers: ${String(providersResp.error)}`);
    }

    const providers = providersResp.data?.providers ?? [];
    const hasConfiguredProviders = providers.some(
      (p) => p.models && Object.keys(p.models).length > 0,
    );

    // Collect all models from all providers
    const sdkModels: ServerProviderModel[] = [];
    for (const provider of providers) {
      if (!provider.models) continue;
      for (const model of Object.values(provider.models)) {
        sdkModels.push(mapOpencodeModel(model));
      }
    }

    const resolvedModels =
      sdkModels.length > 0
        ? [...sdkModels, ...providerModelsFromSettings([], PROVIDER, opencodeSettings.customModels)]
        : builtInModels;

    const probe: ProviderProbeResult = {
      installed: true,
      version: null,
      status: hasConfiguredProviders ? "ready" : "error",
      auth: {
        status: hasConfiguredProviders ? "authenticated" : "unauthenticated",
      },
      ...(!hasConfiguredProviders
        ? {
            message:
              "No providers configured in OpenCode. Run `opencode auth` to set up provider credentials.",
          }
        : {}),
    };

    return buildServerProvider({
      provider: PROVIDER,
      enabled: opencodeSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe,
    });
  }).pipe(Effect.result);

  if (Result.isFailure(statusResult)) {
    const message = statusResult.failure.message;
    const missing =
      message.toLowerCase().includes("enoent") || message.toLowerCase().includes("not found");
    return buildServerProvider({
      provider: PROVIDER,
      enabled: opencodeSettings.enabled,
      checkedAt,
      models: builtInModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "OpenCode binary is not installed or not on PATH."
          : `Failed to execute OpenCode health check: ${message}`,
      },
    });
  }

  return statusResult.success;
});

export const OpencodeProviderLive = Layer.effect(
  OpencodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const snapshotCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        checkOpencodeProviderStatus().pipe(
          Effect.provideService(ServerSettingsService, serverSettings),
        ),
    });

    const checkProvider = Cache.get(snapshotCache, "opencode").pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    return yield* makeManagedServerProvider<OpencodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
