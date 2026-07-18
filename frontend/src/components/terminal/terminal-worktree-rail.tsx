import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { terminalQueryKeys } from "../../features/terminal/queries/terminal-query-keys";
import {
  EMPTY_TERMINAL_PROJECT_CONTEXTS,
  useTerminalProjectContextsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import { updateTerminalProjectContext } from "../../services/terminal";

interface TerminalWorktreeRailProps {
  parentProjectId: string | null;
  onSelectContext: (projectId: string) => void;
}

function railStorageKey(scope: string): string {
  return `viewer.terminal.worktree-rail-collapsed.${scope}`;
}

export function TerminalWorktreeRail({
  parentProjectId,
  onSelectContext,
}: TerminalWorktreeRailProps) {
  const { apiBase, scope, token } = useTerminalRuntime();
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const contextsQuery = useTerminalProjectContextsQuery(parentProjectId);
  const contexts =
    contextsQuery.data ?? EMPTY_TERMINAL_PROJECT_CONTEXTS;
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(railStorageKey(scope)) === "true",
  );
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  useEffect(() => {
    setCollapsed(localStorage.getItem(railStorageKey(scope)) === "true");
  }, [scope]);

  const toggleCollapsed = useMemoizedFn(() => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem(railStorageKey(scope), String(next));
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
          queryKey: terminalQueryKeys.projectContexts(
            scope,
            parentProjectId,
          ),
        });
        setRequestError(null);
      } catch (error) {
        setRequestError(String(error));
      } finally {
        setPendingProjectId(null);
      }
    },
  );

  return (
    <aside
      data-testid="terminal-worktree-rail"
      data-collapsed={collapsed ? "true" : "false"}
      className={[
        "flex min-h-0 shrink-0 flex-col border-r border-slate-800 bg-slate-950 transition-[width] duration-150",
        collapsed ? "w-9" : "w-[236px]",
      ].join(" ")}
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
            return (
              <div
                key={context.projectId}
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
                  <span
                    aria-hidden="true"
                    className={[
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      active
                        ? "bg-emerald-400"
                        : unavailable
                          ? "bg-amber-400"
                          : "bg-slate-600",
                    ].join(" ")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">
                      {context.name}
                    </span>
                    <span className="block truncate text-[10px] text-slate-500">
                      {context.branch ??
                        (context.availability === "missing"
                          ? "missing"
                          : "detached")}
                    </span>
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
                    aria-label={context.pinned ? "Unpin Worktree" : "Pin Worktree"}
                    title={context.pinned ? "Unpin Worktree" : "Pin Worktree"}
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
          })}
        </div>
      ) : null}
    </aside>
  );
}
