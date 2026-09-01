import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMemoizedFn } from "ahooks";
import { useShallow } from "zustand/react/shallow";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import { ChevronLeft, ChevronRight, Pin, Trash2 } from "lucide-react";
import { removeRecentTerminalProjectContext } from "../../../features/terminal/recent-selection";
import { useTerminalPreviewStore } from "../../../features/terminal/preview-store";
import { terminalQueryKeys } from "../../../features/terminal/queries/terminal-query-keys";
import {
  EMPTY_TERMINAL_PROJECT_CONTEXTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectContextsQuery,
  useTerminalSessionsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../../features/terminal/queries/terminal-runtime-provider";
import { useTerminalAggregateStatus } from "../../../features/terminal/use-terminal-aggregate-status";
import { useTerminalWorkspaceStore } from "../../../features/terminal/workspace-store";
import {
  deleteTerminalWorktree,
  updateTerminalProjectContext,
} from "../../../services/terminal";
import { HttpError } from "../../../services/http";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import { TerminalAggregateStatus } from "./aggregate-status";
import type { TerminalBrowserProfilePreferences } from "@runweave/shared/terminal-browser-profile";

interface TerminalWorktreeRailProps {
  parentProjectId: string | null;
  onSelectContext: (projectId: string) => void;
}

const DEFAULT_RAIL_WIDTH_PX = 236;
const MIN_RAIL_WIDTH_PX = 180;
const MAX_RAIL_WIDTH_PX = 420;
const RAIL_KEYBOARD_RESIZE_STEP_PX = 16;

function railCollapsedStorageKey(scope: string): string {
  return `viewer.terminal.worktree-rail-collapsed.${scope}`;
}

function railWidthStorageKey(scope: string): string {
  return `viewer.terminal.worktree-rail-width.${scope}`;
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH_PX, Math.max(MIN_RAIL_WIDTH_PX, width));
}

function readRailWidth(scope: string): number {
  const storedWidth = Number.parseInt(
    localStorage.getItem(railWidthStorageKey(scope)) ?? "",
    10,
  );
  return Number.isFinite(storedWidth)
    ? clampRailWidth(storedWidth)
    : DEFAULT_RAIL_WIDTH_PX;
}

function getContextDetail(context: TerminalProjectContextListItem): string {
  const branch = context.branch ?? "detached";
  if (context.availability === "missing") {
    return `${branch} · missing`;
  }
  if (context.availability === "path_unavailable") {
    return `${branch} · unavailable`;
  }
  return branch;
}

export function TerminalWorktreeRail({
  parentProjectId,
  onSelectContext,
}: TerminalWorktreeRailProps) {
  const { apiBase, onAuthExpired, scope, token } = useTerminalRuntime();
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const contextsQuery = useTerminalProjectContextsQuery(parentProjectId);
  const contexts = contextsQuery.data ?? EMPTY_TERMINAL_PROJECT_CONTEXTS;
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const { activeProjectId, selectProjectContext, setRequestError } =
    useTerminalWorkspaceStore(
      useShallow((state) => ({
        activeProjectId: state.activeProjectId,
        selectProjectContext: state.selectProjectContext,
        setRequestError: state.setRequestError,
      })),
    );
  const removeProjectPreview = useTerminalPreviewStore(
    (state) => state.removeProjectPreview,
  );
  const { byContextProjectId } = useTerminalAggregateStatus();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(railCollapsedStorageKey(scope)) === "true",
  );
  const [width, setWidth] = useState(() => readRailWidth(scope));
  const [resizing, setResizing] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [profilePreferences, setProfilePreferences] =
    useState<TerminalBrowserProfilePreferences | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<TerminalProjectContextListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const resizeStateRef = useRef<{
    railLeft: number;
    width: number;
    scope: string;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);

  const handleResizePointerMove = useMemoizedFn((event: PointerEvent) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState) {
      return;
    }
    const nextWidth = clampRailWidth(
      Math.round(event.clientX - resizeState.railLeft),
    );
    resizeState.width = nextWidth;
    setWidth(nextWidth);
  });

  const stopResize = useMemoizedFn(() => {
    const resizeState = resizeStateRef.current;
    resizeStateRef.current = null;
    window.removeEventListener("pointermove", handleResizePointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    setResizing(false);
    if (!resizeState) {
      return;
    }
    document.body.style.cursor = resizeState.previousCursor;
    document.body.style.userSelect = resizeState.previousUserSelect;
    localStorage.setItem(
      railWidthStorageKey(resizeState.scope),
      String(resizeState.width),
    );
  });

  const startResize = useMemoizedFn(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rail = event.currentTarget.closest("aside");
      if (!rail) {
        return;
      }
      resizeStateRef.current = {
        railLeft: rail.getBoundingClientRect().left,
        width,
        scope,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setResizing(true);
      window.addEventListener("pointermove", handleResizePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
  );

  const resizeWithKeyboard = useMemoizedFn(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const nextWidth =
        event.key === "Home"
          ? MIN_RAIL_WIDTH_PX
          : event.key === "End"
            ? MAX_RAIL_WIDTH_PX
            : event.key === "ArrowLeft"
              ? clampRailWidth(width - RAIL_KEYBOARD_RESIZE_STEP_PX)
              : event.key === "ArrowRight"
                ? clampRailWidth(width + RAIL_KEYBOARD_RESIZE_STEP_PX)
                : null;
      if (nextWidth === null) {
        return;
      }
      event.preventDefault();
      setWidth(nextWidth);
      localStorage.setItem(railWidthStorageKey(scope), String(nextWidth));
    },
  );

  useEffect(() => {
    stopResize();
    setCollapsed(
      localStorage.getItem(railCollapsedStorageKey(scope)) === "true",
    );
    setWidth(readRailWidth(scope));
  }, [scope, stopResize]);

  useEffect(() => stopResize, [stopResize]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      ?.terminalBrowserGetProfilePreferences?.()
      .then((preferences) => {
        if (!cancelled && preferences) setProfilePreferences(preferences);
      });
    const unsubscribe = window.electronAPI?.onTerminalBrowserProfileChanged?.(
      (event) => {
        if (event.kind === "preferences") {
          setProfilePreferences(event.preferences);
        }
      },
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const toggleCollapsed = useMemoizedFn(() => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem(railCollapsedStorageKey(scope), String(next));
      return next;
    });
  });

  const togglePinned = useMemoizedFn(
    async (projectId: string, pinned: boolean): Promise<void> => {
      if (!parentProjectId || pendingProjectId) {
        return;
      }
      setPendingProjectId(projectId);
      try {
        await updateTerminalProjectContext(
          apiBase,
          token,
          parentProjectId,
          projectId,
          pinned,
        );
        await queryClient.invalidateQueries({
          queryKey: terminalQueryKeys.projectContexts(scope, parentProjectId),
        });
        setRequestError(null);
      } catch (error) {
        setRequestError(String(error));
      } finally {
        setPendingProjectId(null);
      }
    },
  );

  const requestDeletion = useMemoizedFn(
    (context: TerminalProjectContextListItem): void => {
      setDeleteError(null);
      setPendingDeletion(context);
    },
  );

  const confirmDeletion = useMemoizedFn(async (): Promise<void> => {
    const target = pendingDeletion;
    if (!target || deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTerminalWorktree(
        apiBase,
        token,
        target.parentProjectId,
        target.projectId,
      );
      removeProjectPreview(target.projectId);
      removeRecentTerminalProjectContext(
        scope,
        target.parentProjectId,
        target.projectId,
      );
      queryClient.removeQueries({
        queryKey: terminalQueryKeys.preview(scope, target.projectId),
      });
      if (activeProjectId === target.projectId) {
        const parentSession = sessions.find(
          (session) => session.projectId === target.parentProjectId,
        );
        selectProjectContext(
          target.parentProjectId,
          target.parentProjectId,
          parentSession?.terminalSessionId ?? null,
        );
      }
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: terminalQueryKeys.projectContexts(
            scope,
            target.parentProjectId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: terminalQueryKeys.sessions(scope),
        }),
      ]).catch((error: unknown) => {
        setRequestError(String(error));
      });
      setRequestError(null);
      setPendingDeletion(null);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  });

  if (contexts.length <= 1 && !pendingDeletion) {
    return null;
  }

  return (
    <>
      {contexts.length > 1 ? (
        <aside
          data-testid="terminal-worktree-rail"
          data-collapsed={collapsed ? "true" : "false"}
          data-resizing={resizing ? "true" : "false"}
          className={[
            "relative flex min-h-0 shrink-0 flex-col border-r border-slate-800 bg-slate-950",
            resizing ? "" : "transition-[width] duration-150",
          ].join(" ")}
          style={{ width: collapsed ? 36 : width }}
        >
          <div
            className={[
              "flex h-7 shrink-0 items-center border-b border-slate-800",
              collapsed ? "justify-center" : "justify-between px-2",
            ].join(" ")}
          >
            {!collapsed ? (
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Worktrees&nbsp; {contexts.length}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={collapsed ? "Expand Worktrees" : "Collapse Worktrees"}
              title={collapsed ? "Expand Worktrees" : "Collapse Worktrees"}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-900 hover:text-slate-200"
              onClick={toggleCollapsed}
            >
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronLeft className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          {!collapsed ? (
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3">
              {contexts.map((context) => {
                const active = context.projectId === activeProjectId;
                const unavailable = context.availability !== "available";
                const status = byContextProjectId[context.projectId] ?? 0;
                const browserPreference =
                  profilePreferences?.worktrees[context.projectId];
                const browserProfileId =
                  browserPreference?.preferredProfileId ??
                  profilePreferences?.defaultProfileId;
                const browserSummary = browserProfileId
                  ? `${browserProfileId.replace("profile-", "P")} · ${
                      browserPreference?.devServerPort
                        ? `:${browserPreference.devServerPort}`
                        : "no port"
                    } · ${
                      browserPreference?.preferredProfileId ? "bound" : "global"
                    }`
                  : null;
                const row = (
                  <div
                    data-testid="terminal-worktree-row"
                    data-project-id={context.projectId}
                    data-active={active ? "true" : "false"}
                    className={[
                      "group flex min-h-12 items-center gap-2 rounded-md border px-2 py-1.5",
                      active
                        ? "border-sky-900/70 bg-slate-900 text-slate-50"
                        : "border-transparent text-slate-300 hover:bg-slate-900/70",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      aria-label={`${context.name}, ${context.branch ?? "detached"}`}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => onSelectContext(context.projectId)}
                    >
                      <span className="min-w-0 flex-1">
                        <TerminalAggregateStatus
                          label={context.name}
                          status={status}
                          className="flex w-full"
                          labelClassName="min-w-0 flex-1 truncate text-xs font-semibold"
                        />
                        <span
                          className={[
                            "block truncate text-[10px]",
                            unavailable ? "text-amber-400" : "text-slate-500",
                          ].join(" ")}
                        >
                          {getContextDetail(context)}
                        </span>
                        {browserSummary ? (
                          <span
                            data-testid="terminal-worktree-browser-profile"
                            className="block truncate text-[9px] text-slate-600"
                          >
                            {browserSummary}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {context.isPrimary ? (
                      <span
                        aria-label="Permanently pinned"
                        title="Permanently pinned"
                        className="flex h-6 w-6 shrink-0 items-center justify-center text-sky-400"
                      >
                        <Pin className="h-3.5 w-3.5 fill-current" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={
                          context.pinned ? "Unpin Worktree" : "Pin Worktree"
                        }
                        title={
                          context.pinned ? "Unpin Worktree" : "Pin Worktree"
                        }
                        disabled={pendingProjectId === context.projectId}
                        className={[
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40",
                          context.pinned ? "text-sky-400" : "text-slate-600",
                        ].join(" ")}
                        onClick={() => {
                          void togglePinned(context.projectId, !context.pinned);
                        }}
                      >
                        <Pin
                          className={[
                            "h-3.5 w-3.5",
                            context.pinned ? "fill-current" : "",
                          ].join(" ")}
                        />
                      </button>
                    )}
                  </div>
                );
                if (context.isPrimary) {
                  return <Fragment key={context.projectId}>{row}</Fragment>;
                }
                return (
                  <ContextMenu key={context.projectId}>
                    <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                    <ContextMenuContent className="w-36">
                      <ContextMenuItem
                        data-testid="terminal-worktree-delete-menu-item"
                        className="gap-2 text-rose-400 focus:text-rose-400"
                        onSelect={() => requestDeletion(context)}
                      >
                        <Trash2 className="h-4 w-4" />
                        删除
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          ) : null}
          {!collapsed ? (
            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize Worktrees panel"
              aria-orientation="vertical"
              aria-valuemin={MIN_RAIL_WIDTH_PX}
              aria-valuemax={MAX_RAIL_WIDTH_PX}
              aria-valuenow={width}
              className="absolute right-0 top-0 z-20 h-full w-2 translate-x-1/2 touch-none cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sky-400/60 focus-visible:before:bg-sky-400/60 data-[resizing=true]:before:w-0.5 data-[resizing=true]:before:bg-sky-400"
              data-resizing={resizing ? "true" : "false"}
              onPointerDown={startResize}
              onKeyDown={resizeWithKeyboard}
            />
          ) : null}
        </aside>
      ) : null}
      <AlertDialog
        open={pendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteError(null);
            setPendingDeletion(null);
          }
        }}
      >
        <AlertDialogContent data-testid="terminal-worktree-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">
                将删除“{pendingDeletion?.name}”的工作目录，并关闭其中的
                {
                  sessions.filter(
                    (session) =>
                      session.projectId === pendingDeletion?.projectId,
                  ).length
                }
                个 Terminal。
              </span>
              <span className="mt-2 block">
                分支 {pendingDeletion?.branch ?? "detached HEAD"} 会被保留。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p
              role="alert"
              data-testid="terminal-worktree-delete-error"
              className="rounded-lg border border-rose-900/70 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
            >
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              data-testid="terminal-worktree-delete-confirm"
              className="bg-rose-500 text-white hover:bg-rose-500/90 hover:shadow-[0_22px_50px_-24px_rgba(244,63,94,0.82)]"
              onClick={(event) => {
                event.preventDefault();
                void confirmDeletion();
              }}
            >
              {deleting ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
