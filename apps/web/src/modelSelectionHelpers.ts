import {
  type ModelSelection,
  type ProviderKind,
  type ProviderModelOptions,
} from "@t3tools/contracts";

export function getProviderModelOptions<P extends ProviderKind>(
  provider: P,
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions[P] | undefined {
  if (provider === "codex") {
    return options?.codex as ProviderModelOptions[P] | undefined;
  }
  if (provider === "claudeAgent") {
    return options?.claudeAgent as ProviderModelOptions[P] | undefined;
  }
  return options?.copilot as ProviderModelOptions[P] | undefined;
}

export function createModelSelection<P extends ProviderKind>(
  provider: P,
  model: string,
  options?: ProviderModelOptions[P],
): Extract<ModelSelection, { provider: P }> {
  if (provider === "codex") {
    return (options ? { provider, model, options } : { provider, model }) as Extract<
      ModelSelection,
      { provider: P }
    >;
  }
  if (provider === "claudeAgent") {
    return (options ? { provider, model, options } : { provider, model }) as Extract<
      ModelSelection,
      { provider: P }
    >;
  }
  return (options ? { provider, model, options } : { provider, model }) as Extract<
    ModelSelection,
    { provider: P }
  >;
}
