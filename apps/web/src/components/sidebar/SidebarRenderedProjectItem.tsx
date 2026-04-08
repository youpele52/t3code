import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import {
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type SetStateAction,
} from "react";
import type { ProjectId, ThreadId } from "@bigcode/contracts";
import { ProjectFavicon } from "../project/ProjectFavicon";
import {
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadSeedContext,
  resolveThreadStatusPill,
  type SidebarNewThreadEnvMode,
} from "./Sidebar.logic";
import type { SortableProjectHandleProps } from "./SidebarProjectItem";
import { SidebarThreadRow, type ThreadPr } from "./SidebarThreadRow";
import { SidebarThreadStatusLabel } from "./SidebarThreadStatusLabel";
import {
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ProjectStatusIndicator = NonNullable<ReturnType<typeof resolveThreadStatusPill>>;

export interface RenderedProjectData {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ProjectStatusIndicator | null;
  orderedProjectThreadIds: readonly ThreadId[];
  project: {
    id: ProjectId;
    name: string;
    cwd: string;
    expanded: boolean;
  };
  projectStatus: ProjectStatusIndicator | null;
  renderedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
}

export interface SidebarRenderedProjectItemProps extends RenderedProjectData {
  dragHandleProps: SortableProjectHandleProps | null;
  isManualProjectSorting: boolean;
  newThreadShortcutLabel: string | null | undefined;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsDefaultThreadEnvMode: SidebarNewThreadEnvMode;
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the rename has already been committed. */
  hasRenameCommitted: () => boolean;
  /** Marks the rename as committed to prevent double-commit on blur. */
  markRenameCommitted: () => void;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  activeThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
  // Project rename
  renamingProjectId: ProjectId | null;
  renamingProjectTitle: string;
  setRenamingProjectTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onProjectRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the project rename has already been committed. */
  hasProjectRenameCommitted: () => boolean;
  /** Marks the project rename as committed to prevent double-commit on blur. */
  markProjectRenameCommitted: () => void;
  commitProjectRename: (
    projectId: ProjectId,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelProjectRename: () => void;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  prByThreadId: Map<ThreadId, ThreadPr>;
  handleNewThread: (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: SidebarNewThreadEnvMode;
    },
  ) => Promise<void>;
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
}

/** Renders a single project entry (header + thread list) in the sidebar project list. */
export function SidebarRenderedProjectItem({
  dragHandleProps,
  isManualProjectSorting,
  hasHiddenThreads,
  hiddenThreadStatus,
  orderedProjectThreadIds,
  project,
  projectStatus,
  renderedThreadIds,
  showEmptyThreadState,
  shouldShowThreadPanel,
  isThreadListExpanded,
  newThreadShortcutLabel,
  showThreadJumpHints,
  threadJumpLabelById,
  appSettingsConfirmThreadArchive,
  appSettingsDefaultThreadEnvMode,
  routeThreadId,
  selectedThreadIds,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  onRenamingInputMount,
  hasRenameCommitted,
  markRenameCommitted,
  confirmingArchiveThreadId,
  setConfirmingArchiveThreadId,
  confirmArchiveButtonRefs,
  activeThread,
  activeDraftThread,
  renamingProjectId,
  renamingProjectTitle,
  setRenamingProjectTitle,
  onProjectRenamingInputMount,
  hasProjectRenameCommitted,
  markProjectRenameCommitted,
  commitProjectRename,
  cancelProjectRename,
  attachThreadListAutoAnimateRef,
  handleProjectTitlePointerDownCapture,
  handleProjectTitleClick,
  handleProjectTitleKeyDown,
  handleProjectContextMenu,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  handleThreadContextMenu,
  clearSelection,
  commitRename,
  cancelRename,
  attemptArchiveThread,
  openPrLink,
  prByThreadId,
  handleNewThread,
  expandThreadListForProject,
  collapseThreadListForProject,
}: SidebarRenderedProjectItemProps) {
  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          }`}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectTitlePointerDownCapture}
          onClick={(event) => handleProjectTitleClick(event, project.id)}
          onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            handleProjectContextMenu(project.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          {!project.expanded && projectStatus ? (
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                <span
                  className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                    projectStatus.pulse ? "animate-pulse" : ""
                  }`}
                />
              </span>
              <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
            </span>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                project.expanded ? "rotate-90" : ""
              }`}
            />
          )}
          <ProjectFavicon cwd={project.cwd} />
          {renamingProjectId === project.id ? (
            <input
              ref={onProjectRenamingInputMount}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs font-medium text-foreground/90 outline-none"
              value={renamingProjectTitle}
              onChange={(event) => setRenamingProjectTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  markProjectRenameCommitted();
                  void commitProjectRename(project.id, renamingProjectTitle, project.name);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  markProjectRenameCommitted();
                  cancelProjectRename();
                }
              }}
              onBlur={() => {
                if (!hasProjectRenameCommitted()) {
                  markProjectRenameCommitted();
                  void commitProjectRename(project.id, renamingProjectTitle, project.name);
                }
              }}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate text-xs font-medium text-foreground/90">
              {project.name}
            </span>
          )}
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.name}`}
                    data-testid="new-thread-button"
                  />
                }
                showOnHover
                className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const seedContext = resolveSidebarNewThreadSeedContext({
                    projectId: project.id,
                    defaultEnvMode: resolveSidebarNewThreadEnvMode({
                      defaultEnvMode: appSettingsDefaultThreadEnvMode,
                    }),
                    activeThread:
                      activeThread && activeThread.projectId === project.id
                        ? {
                            projectId: activeThread.projectId,
                            branch: activeThread.branch,
                            worktreePath: activeThread.worktreePath,
                          }
                        : null,
                    activeDraftThread:
                      activeDraftThread && activeDraftThread.projectId === project.id
                        ? {
                            projectId: activeDraftThread.projectId,
                            branch: activeDraftThread.branch,
                            worktreePath: activeDraftThread.worktreePath,
                            envMode: activeDraftThread.envMode,
                          }
                        : null,
                  });
                  void handleNewThread(project.id, {
                    ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
                    ...(seedContext.worktreePath !== undefined
                      ? { worktreePath: seedContext.worktreePath }
                      : {}),
                    envMode: seedContext.envMode,
                  });
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarMenuSub
        ref={attachThreadListAutoAnimateRef}
        className="my-0 ml-3 mr-1 translate-x-px gap-0.5 overflow-hidden border-l border-sidebar-border pl-6 pr-1 py-0"
      >
        {shouldShowThreadPanel && showEmptyThreadState ? (
          <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
            <div
              data-thread-selection-safe
              className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
            >
              <span>No threads yet</span>
            </div>
          </SidebarMenuSubItem>
        ) : null}
        {shouldShowThreadPanel &&
          renderedThreadIds.map((threadId) => (
            <SidebarThreadRow
              key={threadId}
              threadId={threadId}
              orderedProjectThreadIds={orderedProjectThreadIds}
              routeThreadId={routeThreadId}
              selectedThreadIds={selectedThreadIds}
              showThreadJumpHints={showThreadJumpHints}
              jumpLabel={threadJumpLabelById.get(threadId) ?? null}
              appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
              renamingThreadId={renamingThreadId}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              onRenamingInputMount={onRenamingInputMount}
              hasRenameCommitted={hasRenameCommitted}
              markRenameCommitted={markRenameCommitted}
              confirmingArchiveThreadId={confirmingArchiveThreadId}
              setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              handleThreadContextMenu={handleThreadContextMenu}
              clearSelection={clearSelection}
              commitRename={commitRename}
              cancelRename={cancelRename}
              attemptArchiveThread={attemptArchiveThread}
              openPrLink={openPrLink}
              pr={prByThreadId.get(threadId) ?? null}
            />
          ))}

        {project.expanded && hasHiddenThreads && !isThreadListExpanded && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                expandThreadListForProject(project.id);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {hiddenThreadStatus && (
                  <SidebarThreadStatusLabel status={hiddenThreadStatus} compact />
                )}
                <span>Show more</span>
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
        {project.expanded && hasHiddenThreads && isThreadListExpanded && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                collapseThreadListForProject(project.id);
              }}
            >
              <span>Show less</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
      </SidebarMenuSub>
    </>
  );
}
