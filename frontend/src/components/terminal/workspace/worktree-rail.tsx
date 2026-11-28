import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import { useShallow } from "zustand/react/shallow";
import type {
  TerminalProjectContextListItem,
  WorktreeGovernanceItem,
} from "@runweave/shared/terminal/project-context";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
import { removeRecentTerminalProjectContext } from "../../../features/terminal/input/recent-selection";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import { terminalQueryKeys } from "../../../features/terminal/queries/keys";
import {
  EMPTY_TERMINAL_PROJECT_CONTEXTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectContextsQuery,
  useTerminalSessionsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../../features/terminal/queries/workspace";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalProjectContextBranchStatuses } from "../../../features/terminal/queries/branch-status";
import { useTerminalAggregateStatus } from "../../../features/terminal/status/use-aggregate-status";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import {
  deleteTerminalWorktree,
  getWorktreeGovernance,
  updateTerminalProjectContext,
} from "../../../services/terminal/index";
import { HttpError } from "../../../services/http";
import {
  MAX_RAIL_WIDTH_PX,
  MIN_RAIL_WIDTH_PX,
  useWorktreeRailLayout,
} from "./use-worktree-rail-layout";
import { WorktreeCreateDialog } from "./worktree-create-dialog";
import { WorktreeDeleteDialog } from "./worktree-delete-dialog";
import { WorktreeGovernanceDialog } from "./worktree-governance-dialog";
import { WorktreeCleanupNotice } from "./worktree-cleanup-notice";
import { WorktreeRailRow } from "./worktree-rail-row";
import type { TerminalBrowserProfilePreferences } from "@runweave/shared/terminal-browser-profile";

interface TerminalWorktreeRailProps {
  parentProjectId: string | null;
  onSelectContext: (projectId: string) => void;
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
  const {
    collapsed,
    setCollapsed,
    width,
    resizing,
    startResize,
    resizeWithKeyboard,
    toggleCollapsed,
  } = useWorktreeRailLayout(scope);
  const branchStatuses = useTerminalProjectContextBranchStatuses(
    parentProjectId, contexts, !collapsed && contexts.length > 0,
  );
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [profilePreferences, setProfilePreferences] =
    useState<TerminalBrowserProfilePreferences | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<TerminalProjectContextListItem | null>(null);
  const [createTarget, setCreateTarget] = useState<{
    key: string;
    recycleSlotId?: string;
  } | null>(null);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [cleanableExpanded, setCleanableExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const governanceQuery = useQuery({
    queryKey: parentProjectId
      ? terminalQueryKeys.worktreeGovernance(scope, parentProjectId)
      : ["disabled-worktree-governance"],
    queryFn: () =>
      getWorktreeGovernance(apiBase, token, parentProjectId!, false),
    enabled: Boolean(parentProjectId && !collapsed && contexts.length > 1),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const governanceById = new Map<string, WorktreeGovernanceItem>(
    (governanceQuery.data?.items ?? []).map((item) => [item.projectId, item]),
  );
  useEffect(() => {
    setCleanupNotice(null);
    setGovernanceOpen(false);
    setCleanableExpanded(false);
  }, [scope, parentProjectId]);

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
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: terminalQueryKeys.projectContexts(scope, parentProjectId),
          }),
          queryClient.invalidateQueries({
            queryKey: terminalQueryKeys.worktreeGovernance(
              scope,
              parentProjectId,
            ),
          }),
        ]);
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
      const result = await deleteTerminalWorktree(
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
      if (result.cleanupWarnings.length > 0) {
        setCleanupNotice(
          `Worktree 已删除，部分服务未清理：${result.cleanupWarnings
            .map(
              (warning) =>
                `${warning.devSessionId ?? "Dev Session"}（${warning.message}）`,
            )
            .join("；")}`,
        );
        setCollapsed(false);
      } else {
        setCleanupNotice(null);
      }
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

  const foldableBuckets = new Set([
    "idle_hot_slot",
    "cleanable_merged",
    "cleanable_stale",
  ]);
  const visibleContexts: TerminalProjectContextListItem[] = [];
  const foldedCleanableContexts: TerminalProjectContextListItem[] = [];
  for (const context of contexts) {
    const gov = governanceById.get(context.projectId);
    const shouldFold =
      !context.isPrimary &&
      !context.pinned &&
      context.projectId !== activeProjectId &&
      gov !== undefined &&
      foldableBuckets.has(gov.bucket);
    if (shouldFold) {
      foldedCleanableContexts.push(context);
    } else {
      visibleContexts.push(context);
    }
  }
  const governanceBadgeCount =
    (governanceQuery.data?.items.filter((item) => item.canSafeDelete).length ??
      0) + (governanceQuery.data?.prunable.length ?? 0);

  const openRecycleDialog = useMemoizedFn((projectId: string) => {
    if (!parentProjectId) return;
    setCreateTarget({
      key: JSON.stringify([scope, parentProjectId]),
      recycleSlotId: projectId,
    });
  });

  const renderContextRow = (context: TerminalProjectContextListItem) => (
    <WorktreeRailRow
      key={context.projectId}
      context={context}
      active={context.projectId === activeProjectId}
      status={byContextProjectId[context.projectId] ?? 0}
      governance={governanceById.get(context.projectId)}
      branchStatus={branchStatuses.data?.find(
        (entry) =>
          entry.projectId === context.projectId &&
          entry.path === context.path &&
          entry.head === context.head,
      )}
      branchStatusFailed={branchStatuses.isError}
      profilePreferences={profilePreferences}
      pinPending={pendingProjectId === context.projectId}
      onSelect={onSelectContext}
      onTogglePinned={(projectId, pinned) => {
        void togglePinned(projectId, pinned);
      }}
      onRecycle={openRecycleDialog}
      onDelete={requestDeletion}
    />
  );

  return (
    <>
      {(
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
            <div className="flex items-center gap-0.5">
              {!collapsed && parentProjectId && contexts.length > 1 ? (
                <button
                  type="button"
                  data-testid="terminal-worktree-governance-trigger"
                  aria-label="整理 Worktree"
                  title="整理 Worktree（批量清理与复用）"
                  className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                  onClick={() => setGovernanceOpen(true)}
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  整理
                  {governanceBadgeCount > 0 ? (
                    <span className="rounded-full bg-emerald-500/20 px-1 text-[9px] text-emerald-300">
                      {governanceBadgeCount}
                    </span>
                  ) : null}
                </button>
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
          </div>
          {cleanupNotice && !collapsed ? (
            <WorktreeCleanupNotice
              message={cleanupNotice}
              onDismiss={() => setCleanupNotice(null)}
            />
          ) : null}
          {!collapsed ? (
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3">
              {visibleContexts.map(renderContextRow)}
              {foldedCleanableContexts.length > 0 ? (
                <div className="pt-2">
                  <button
                    type="button"
                    data-testid="terminal-worktree-cleanable-fold"
                    className="flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-900/50 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                    onClick={() => setCleanableExpanded((prev) => !prev)}
                  >
                    <span>可清理 / 空闲槽位 ({foldedCleanableContexts.length})</span>
                    {cleanableExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {cleanableExpanded ? (
                    <div className="mt-1 space-y-1">
                      {foldedCleanableContexts.map(renderContextRow)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {parentProjectId && (
            <button
              type="button"
              aria-label="新建 Worktree"
              title="新建或复用 Worktree"
              className="border-t border-slate-800 p-2 text-xs text-sky-400 hover:bg-slate-900"
              onClick={() =>
                setCreateTarget({
                  key: JSON.stringify([scope, parentProjectId]),
                })
              }
            >
              {collapsed ? "＋" : "＋ 新建 Worktree"}
            </button>
          )}
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
      )}
      {parentProjectId &&
        createTarget &&
        createTarget.key === JSON.stringify([scope, parentProjectId]) && (
          <WorktreeCreateDialog
            key={`${createTarget.key}:${createTarget.recycleSlotId ?? ""}`}
            apiBase={apiBase}
            token={token}
            parent={parentProjectId}
            initialRecycleSlotId={createTarget.recycleSlotId}
            close={() => setCreateTarget(null)}
            created={(result) => {
              void Promise.all([
                queryClient.invalidateQueries({
                  queryKey: terminalQueryKeys.projectContexts(
                    scope,
                    parentProjectId,
                  ),
                }),
                queryClient.invalidateQueries({
                  queryKey: terminalQueryKeys.worktreeGovernance(
                    scope,
                    parentProjectId,
                  ),
                }),
                queryClient.invalidateQueries({
                  queryKey: terminalQueryKeys.sessions(scope),
                }),
              ])
                .then(() => {
                  selectProjectContext(
                    parentProjectId,
                    result.projectId,
                    result.terminalSessionId,
                  );
                  setCollapsed(false);
                  setRequestError(
                    result.setupStatus === "revision_mismatch_skipped"
                      ? "检出的初始化命令与批准版本不符，已跳过。"
                      : null,
                  );
                })
                .catch((error) => setRequestError(String(error)));
              setCreateTarget(null);
            }}
          />
        )}
      {parentProjectId && governanceOpen ? (
        <WorktreeGovernanceDialog
          apiBase={apiBase}
          token={token}
          parentProjectId={parentProjectId}
          onClose={() => setGovernanceOpen(false)}
          onRecycleItem={(childProjectId) => {
            setGovernanceOpen(false);
            setCreateTarget({
              key: JSON.stringify([scope, parentProjectId]),
              recycleSlotId: childProjectId,
            });
          }}
          onCompleted={(response) => {
            const deletedIds = new Set(
              response.results
                .filter((entry) => entry.status === "deleted")
                .map((entry) => entry.childProjectId),
            );
            for (const id of deletedIds) {
              removeProjectPreview(id);
              removeRecentTerminalProjectContext(scope, parentProjectId, id);
              queryClient.removeQueries({
                queryKey: terminalQueryKeys.preview(scope, id),
              });
            }
            if (activeProjectId && deletedIds.has(activeProjectId)) {
              const parentSession = sessions.find(
                (session) => session.projectId === parentProjectId,
              );
              selectProjectContext(
                parentProjectId,
                parentProjectId,
                parentSession?.terminalSessionId ?? null,
              );
            }
            void Promise.all([
              queryClient.invalidateQueries({
                queryKey: terminalQueryKeys.projectContexts(
                  scope,
                  parentProjectId,
                ),
              }),
              queryClient.invalidateQueries({
                queryKey: terminalQueryKeys.worktreeGovernance(
                  scope,
                  parentProjectId,
                ),
              }),
              queryClient.invalidateQueries({
                queryKey: terminalQueryKeys.sessions(scope),
              }),
            ]);
          }}
        />
      ) : null}
      <WorktreeDeleteDialog
        pendingDeletion={pendingDeletion}
        sessionCount={sessions.filter((session) => session.projectId === pendingDeletion?.projectId).length}
        deleting={deleting}
        deleteError={deleteError}
        onDismiss={() => {
          setDeleteError(null);
          setPendingDeletion(null);
        }}
        onConfirm={confirmDeletion}
      />
    </>
  );
}
