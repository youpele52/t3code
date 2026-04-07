import { type ModelSelection, type ProviderKind } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";

import { normalizeModelSlug } from "@t3tools/shared/model";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import { basenameOfPath } from "../../../../lib/vscode-icons";
import { shortcutLabelForCommand } from "../../../../models/keybindings";
import {
  createModelSelection,
  getProviderModels,
  resolveSelectableProvider,
} from "../../../../models/provider";
import { useEffectiveComposerModelState } from "../../../../stores/composer";
import { AVAILABLE_PROVIDER_OPTIONS } from "../../provider/ProviderModelPicker";
import { getComposerProviderState } from "../../provider/composerProviderRegistry";
import { getModelSelectionSubProviderID, modelPickerValue } from "../ChatView.modelSelection.logic";
import { COMPOSER_PATH_QUERY_DEBOUNCE_MS } from "../ChatView.constants.logic";
import { type ComposerCommandItem } from "../../composer/ComposerCommandMenu";
import { threadHasStarted } from "../ChatView.logic";

import { EMPTY_PROJECT_ENTRIES, EMPTY_PROVIDERS } from "./shared";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";

export function useChatViewComposerDerivedState(base: ChatViewBaseState) {
  const sessionProvider = base.activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = base.composerDraft.activeProvider ?? null;
  const threadProvider =
    base.activeThread?.modelSelection.provider ??
    base.activeProject?.defaultModelSelection?.provider ??
    null;
  const hasThreadStarted = threadHasStarted(base.activeThread);
  const lockedProvider: ProviderKind | null =
    hasThreadStarted && !base.providerUnlocked
      ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
      : null;

  const serverConfig = useServerConfig();
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: base.threadId,
    providers: providerStatuses,
    selectedProvider,
    threadModelSelection: base.activeThread?.modelSelection,
    projectModelSelection: base.activeProject?.defaultModelSelection,
    settings: base.settings,
  });

  const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
  const selectedDraftOrThreadModelSelection =
    base.composerDraft.modelSelectionByProvider[selectedProvider] ??
    (base.activeThread?.modelSelection.provider === selectedProvider
      ? base.activeThread.modelSelection
      : null) ??
    (base.activeProject?.defaultModelSelection?.provider === selectedProvider
      ? base.activeProject.defaultModelSelection
      : null);

  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt: base.prompt,
        modelOptions: composerModelOptions,
      }),
    [base.prompt, composerModelOptions, selectedModel, selectedProvider, selectedProviderModels],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    const baseSelection = createModelSelection(
      selectedProvider,
      selectedModel,
      selectedModelOptionsForDispatch,
    );
    if (selectedProvider === "opencode") {
      const opcModels = providerStatuses.find((p) => p.provider === "opencode")?.models ?? [];
      const currentSubProviderID = getModelSelectionSubProviderID(
        selectedDraftOrThreadModelSelection,
      );
      const matched = opcModels.find(
        (m) =>
          m.slug === selectedModel &&
          (currentSubProviderID === null || m.subProviderID === currentSubProviderID),
      );
      if (matched?.subProviderID) {
        return { ...baseSelection, subProviderID: matched.subProviderID } as ModelSelection;
      }
    }
    return baseSelection;
  }, [
    providerStatuses,
    selectedDraftOrThreadModelSelection,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
  ]);

  const selectedModelForPicker = modelPickerValue(selectedModelSelection);
  const gitCwd = base.activeProject
    ? projectScriptCwd({
        project: { cwd: base.activeProject.cwd },
        worktreePath: base.activeThread?.worktreePath ?? null,
      })
    : null;
  const composerTriggerKind = base.composerTrigger?.kind ?? null;
  const pathTriggerQuery = base.composerTrigger?.kind === "path" ? base.composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const gitStatusQuery = useQuery(gitStatusQueryOptions(gitCwd));
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const modelOptionsByProvider = useMemo(
    () => ({
      codex: providerStatuses.find((provider) => provider.provider === "codex")?.models ?? [],
      claudeAgent:
        providerStatuses.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
      copilot: providerStatuses.find((provider) => provider.provider === "copilot")?.models ?? [],
      opencode: providerStatuses.find((provider) => provider.provider === "opencode")?.models ?? [],
    }),
    [providerStatuses],
  );

  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some(
      (option) =>
        modelPickerValue({
          provider: selectedProvider,
          model: option.slug,
          ...(option.subProviderID ? { subProviderID: option.subProviderID } : {}),
        } as ModelSelection) === selectedModelForPicker,
    )
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);

  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name, subProviderID }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          subProviderID,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );

  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!base.composerTrigger) return [];
    if (base.composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (base.composerTrigger.kind === "slash-command") {
      const slashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const query = base.composerTrigger.query.trim().toLowerCase();
      if (!query) {
        return [...slashCommandItems];
      }
      return slashCommandItems.filter(
        (item) => item.command.includes(query) || item.label.slice(1).includes(query),
      );
    }

    const query = base.composerTrigger?.query.trim().toLowerCase() ?? "";

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name, subProviderID }) => {
        const item: Extract<ComposerCommandItem, { type: "model" }> = {
          id: `model:${provider}:${subProviderID ?? "default"}:${slug}`,
          type: "model",
          provider,
          model: slug,
          label: name,
          description: `${providerLabel} · ${slug}`,
        };
        if (subProviderID !== undefined) {
          item.subProviderID = subProviderID;
        }
        return item;
      });
  }, [base.composerTrigger, searchableModelOptions, workspaceEntries]);

  const composerMenuOpen = Boolean(base.composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === base.composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [base.composerHighlightedItemId, composerMenuItems],
  );

  base.composerMenuOpenRef.current = composerMenuOpen;
  base.composerMenuItemsRef.current = composerMenuItems;
  base.activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(base.nonPersistedComposerImageIds),
    [base.nonPersistedComposerImageIds],
  );
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
    [selectedProvider, providerStatuses],
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: { terminalFocus: true, terminalOpen: Boolean(base.terminalState.terminalOpen) },
    }),
    [base.terminalState.terminalOpen],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: { terminalFocus: false, terminalOpen: Boolean(base.terminalState.terminalOpen) },
    }),
    [base.terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const sidebarToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "sidebar.toggle"),
    [keybindings],
  );

  return {
    sessionProvider,
    selectedProviderByThreadId,
    threadProvider,
    hasThreadStarted,
    lockedProvider,
    providerStatuses,
    selectedProvider,
    composerModelOptions,
    selectedModel,
    selectedProviderModels,
    selectedDraftOrThreadModelSelection,
    composerProviderState,
    selectedPromptEffort,
    selectedModelOptionsForDispatch,
    selectedModelSelection,
    selectedModelForPicker,
    gitCwd,
    composerTriggerKind,
    pathTriggerQuery,
    composerPathQueryDebouncer,
    effectivePathQuery,
    gitStatusQuery,
    keybindings,
    availableEditors,
    modelOptionsByProvider,
    selectedModelForPickerWithCustomFallback,
    workspaceEntriesQuery,
    workspaceEntries,
    composerMenuItems,
    composerMenuOpen,
    activeComposerMenuItem,
    nonPersistedComposerImageIdSet,
    activeProviderStatus,
    isGitRepo,
    terminalToggleShortcutLabel,
    splitTerminalShortcutLabel,
    newTerminalShortcutLabel,
    closeTerminalShortcutLabel,
    diffPanelShortcutLabel,
    sidebarToggleShortcutLabel,
  };
}

export type ChatViewComposerDerivedState = ReturnType<typeof useChatViewComposerDerivedState>;
