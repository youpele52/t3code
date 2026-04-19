import { BUILT_IN_CHATS_PROJECT_ID, isBuiltInChatsProject } from "@bigcode/contracts";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  resolveContextualNewThreadOptions,
  resolveNewChatOptions,
  useHandleNewThread,
} from "../hooks/useHandleNewThread";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../models/keybindings";
import { selectThreadTerminalState } from "../stores/terminal";
import { useTerminalStateStore } from "../stores/terminal";
import { useThreadSelectionStore } from "../stores/thread";
import { useCommandPaletteStore } from "../stores/ui";
import { resolveSidebarNewThreadEnvMode } from "~/components/sidebar/Sidebar.logic";
import { useSidebar } from "~/components/ui/sidebar";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const appSettings = useSettings();
  const { toggleSidebar } = useSidebar();
  const commandPaletteOpen = useCommandPaletteStore((state) => state.open);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (commandPaletteOpen) return;

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (command === "chat.newLocal") {
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId ?? null;
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId ?? null;
        const targetProjectId =
          projectId && !isBuiltInChatsProject(projectId)
            ? BUILT_IN_CHATS_PROJECT_ID
            : (projectId ?? BUILT_IN_CHATS_PROJECT_ID);
        void handleNewThread(
          targetProjectId,
          isBuiltInChatsProject(targetProjectId)
            ? resolveNewChatOptions()
            : resolveContextualNewThreadOptions({ activeDraftThread, activeThread }),
        );
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectId,
    selectedThreadIdsSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
    commandPaletteOpen,
    toggleSidebar,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
