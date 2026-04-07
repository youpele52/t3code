import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { isElectron } from "../../config/env";
import { isLinuxPlatform } from "../../lib/utils";
import { useStore } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { useSidebarGitStatus } from "../../hooks/useSidebarGitStatus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../../hooks/useDesktopUpdateState";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  orderItemsByPreferredIds,
} from "./Sidebar.logic";
import {
  getArm64IntelBuildWarningDescription,
  shouldShowArm64IntelBuildWarning,
} from "../layout/desktopUpdate.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { useSidebarProjectActions } from "./Sidebar.projectActions";
import { useSidebarThreadActions } from "./Sidebar.threadActions";
import { useSidebarRenderedProjects } from "./Sidebar.renderedProjects";
import type { SharedProjectItemProps, SidebarProjectSnapshot, SidebarState } from "./Sidebar.types";

/** Thin composition hook — wires sub-hooks together and assembles `SidebarState`. */
export function useSidebarState(): SidebarState {
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { projectExpandedById, projectOrder } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
    })),
  );

  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const platform = navigator.platform;
  const isLinuxDesktop = isElectron && isLinuxPlatform(platform);
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;

  const {
    activeDraftThread,
    activeThread: activeThreadFull,
    handleNewThread,
  } = useHandleNewThread();

  const activeThread = useMemo(
    () =>
      activeThreadFull
        ? {
            projectId: activeThreadFull.projectId,
            branch: activeThreadFull.branch,
            worktreePath: activeThreadFull.worktreePath,
          }
        : null,
    [activeThreadFull],
  );

  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const {
    desktopUpdateState,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    handleDesktopUpdateButtonClick,
  } = useDesktopUpdateState();

  // ── Ordered / snapshot projects ────────────────────────────────────────────
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: (project) => project.id,
      }),
    [projectOrder, projects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      orderedProjects.map((project) => ({
        ...project,
        expanded: projectExpandedById[project.id] ?? true,
      })),
    [orderedProjects, projectExpandedById],
  );

  const sidebarThreads = useMemo(() => Object.values(sidebarThreadsById), [sidebarThreadsById]);

  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );

  const threadGitTargets = useMemo(
    () =>
      sidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, sidebarThreads],
  );
  const prByThreadId = useSidebarGitStatus(threadGitTargets);

  // ── Shared refs (passed to sub-hooks) ──────────────────────────────────────
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);

  // ── Sorted projects (passed to renderedProjects) ───────────────────────────
  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(sidebarProjects, visibleThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleThreads],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";

  // ── Clipboard helper shared with project actions ───────────────────────────
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  // ── Add-project form state ─────────────────────────────────────────────────
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;

  // ── focusMostRecentThread (shared between project actions and thread route) ─
  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        (threadIdsByProjectId[projectId as string] ?? [])
          .map((threadId) => sidebarThreadsById[threadId as string])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;
      void navigate({ to: "/$threadId", params: { threadId: latestThread.id } });
    },
    [appSettings.sidebarThreadSortOrder, navigate, sidebarThreadsById, threadIdsByProjectId],
  );

  // ── Navigate to thread route (shared by thread actions) ───────────────────
  const navigateToThreadRoute = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  // ── Thread actions sub-hook ────────────────────────────────────────────────
  const threadActions = useSidebarThreadActions({
    sidebarThreadsById,
    projectCwdById,
    appSettings,
    navigateToThreadRoute,
  });

  // ── Project actions sub-hook ───────────────────────────────────────────────
  const projectActions = useSidebarProjectActions({
    projects,
    threadIdsByProjectId,
    sidebarProjects,
    appSettings,
    isAddingProject,
    setIsAddingProject,
    newCwd,
    setNewCwd,
    setAddProjectError,
    setAddingProject: (updater) => setAddingProject(updater),
    isPickingFolder,
    setIsPickingFolder,
    addProjectInputRef,
    shouldBrowseForProjectImmediately,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    selectedThreadIdsSize: threadActions.selectedThreadIds.size,
    clearSelection: threadActions.clearSelection,
    copyPathToClipboard,
    focusMostRecentThreadForProject,
    handleNewThread,
  });

  // ── Rendered projects + jump hints + keyboard nav sub-hook ────────────────
  const renderedProjectsState = useSidebarRenderedProjects({
    sortedProjects,
    routeThreadId,
    navigateToThread: threadActions.navigateToThread,
    platform,
  });

  // ── Global mousedown handler to clear thread selection ────────────────────
  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (threadActions.selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      threadActions.clearSelection();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [threadActions]);

  // ── ARM64 warning ──────────────────────────────────────────────────────────
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;

  // ── Shared props bundle ────────────────────────────────────────────────────
  const sharedProjectItemProps = useMemo(
    (): SharedProjectItemProps => ({
      isManualProjectSorting,
      newThreadShortcutLabel: renderedProjectsState.newThreadShortcutLabel,
      showThreadJumpHints: renderedProjectsState.showThreadJumpHints,
      threadJumpLabelById: renderedProjectsState.threadJumpLabelById,
      appSettingsConfirmThreadArchive: appSettings.confirmThreadArchive,
      appSettingsDefaultThreadEnvMode: appSettings.defaultThreadEnvMode,
      routeThreadId,
      selectedThreadIds: threadActions.selectedThreadIds,
      renamingThreadId: threadActions.renamingThreadId,
      renamingTitle: threadActions.renamingTitle,
      setRenamingTitle: threadActions.setRenamingTitle,
      renamingInputRef: threadActions.renamingInputRef,
      renamingCommittedRef: threadActions.renamingCommittedRef,
      confirmingArchiveThreadId: threadActions.confirmingArchiveThreadId,
      setConfirmingArchiveThreadId: threadActions.setConfirmingArchiveThreadId,
      confirmArchiveButtonRefs: threadActions.confirmArchiveButtonRefs,
      activeThread,
      activeDraftThread,
      attachThreadListAutoAnimateRef: renderedProjectsState.attachThreadListAutoAnimateRef,
      handleProjectTitlePointerDownCapture: projectActions.handleProjectTitlePointerDownCapture,
      handleProjectTitleClick: projectActions.handleProjectTitleClick,
      handleProjectTitleKeyDown: projectActions.handleProjectTitleKeyDown,
      handleProjectContextMenu: projectActions.handleProjectContextMenu,
      handleThreadClick: threadActions.handleThreadClick,
      navigateToThread: threadActions.navigateToThread,
      handleMultiSelectContextMenu: threadActions.handleMultiSelectContextMenu,
      handleThreadContextMenu: threadActions.handleThreadContextMenu,
      clearSelection: threadActions.clearSelection,
      commitRename: threadActions.commitRename,
      cancelRename: threadActions.cancelRename,
      attemptArchiveThread: threadActions.attemptArchiveThread,
      openPrLink: threadActions.openPrLink,
      prByThreadId,
      handleNewThread,
      expandThreadListForProject: renderedProjectsState.expandThreadListForProject,
      collapseThreadListForProject: renderedProjectsState.collapseThreadListForProject,
    }),
    [
      isManualProjectSorting,
      renderedProjectsState.newThreadShortcutLabel,
      renderedProjectsState.showThreadJumpHints,
      renderedProjectsState.threadJumpLabelById,
      renderedProjectsState.attachThreadListAutoAnimateRef,
      renderedProjectsState.expandThreadListForProject,
      renderedProjectsState.collapseThreadListForProject,
      appSettings.confirmThreadArchive,
      appSettings.defaultThreadEnvMode,
      routeThreadId,
      threadActions,
      activeThread,
      activeDraftThread,
      projectActions,
      prByThreadId,
      handleNewThread,
    ],
  );

  return {
    projects,
    bootstrapComplete,
    renderedProjects: renderedProjectsState.renderedProjects,
    isManualProjectSorting,
    isOnSettings,
    pathname,
    prByThreadId,
    appSettings,
    desktopUpdateState,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    handleDesktopUpdateButtonClick,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    addingProject,
    newCwd,
    isPickingFolder,
    isAddingProject,
    addProjectError,
    addProjectInputRef,
    shouldShowProjectPathEntry,
    setNewCwd,
    setAddProjectError,
    handleStartAddProject: projectActions.handleStartAddProject,
    handleAddProject: projectActions.handleAddProject,
    handlePickFolder: projectActions.handlePickFolder,
    cancelAddProject: projectActions.cancelAddProject,
    renamingThreadId: threadActions.renamingThreadId,
    renamingTitle: threadActions.renamingTitle,
    setRenamingTitle: threadActions.setRenamingTitle,
    renamingInputRef: threadActions.renamingInputRef,
    renamingCommittedRef: threadActions.renamingCommittedRef,
    cancelRename: threadActions.cancelRename,
    commitRename: threadActions.commitRename,
    confirmingArchiveThreadId: threadActions.confirmingArchiveThreadId,
    setConfirmingArchiveThreadId: threadActions.setConfirmingArchiveThreadId,
    confirmArchiveButtonRefs: threadActions.confirmArchiveButtonRefs,
    attemptArchiveThread: threadActions.attemptArchiveThread,
    pendingDeleteConfirmation: threadActions.pendingDeleteConfirmation,
    dismissPendingDeleteConfirmation: threadActions.dismissPendingDeleteConfirmation,
    confirmPendingDeleteThreads: threadActions.confirmPendingDeleteThreads,
    selectedThreadIds: threadActions.selectedThreadIds,
    clearSelection: threadActions.clearSelection,
    handleProjectDragStart: projectActions.handleProjectDragStart,
    handleProjectDragEnd: projectActions.handleProjectDragEnd,
    handleProjectDragCancel: projectActions.handleProjectDragCancel,
    handleProjectTitlePointerDownCapture: projectActions.handleProjectTitlePointerDownCapture,
    handleProjectTitleClick: projectActions.handleProjectTitleClick,
    handleProjectTitleKeyDown: projectActions.handleProjectTitleKeyDown,
    handleProjectContextMenu: projectActions.handleProjectContextMenu,
    handleThreadClick: threadActions.handleThreadClick,
    navigateToThread: threadActions.navigateToThread,
    handleMultiSelectContextMenu: threadActions.handleMultiSelectContextMenu,
    handleThreadContextMenu: threadActions.handleThreadContextMenu,
    openPrLink: threadActions.openPrLink,
    handleNewThread,
    expandThreadListForProject: renderedProjectsState.expandThreadListForProject,
    collapseThreadListForProject: renderedProjectsState.collapseThreadListForProject,
    attachThreadListAutoAnimateRef: renderedProjectsState.attachThreadListAutoAnimateRef,
    sharedProjectItemProps,
    updateSettings,
    newThreadShortcutLabel: renderedProjectsState.newThreadShortcutLabel,
    showThreadJumpHints: renderedProjectsState.showThreadJumpHints,
    threadJumpLabelById: renderedProjectsState.threadJumpLabelById,
  };
}
