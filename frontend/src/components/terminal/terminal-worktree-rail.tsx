import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { terminalQueryKeys } from "../../features/terminal/queries/terminal-query-keys";
import {
  EMPTY_TERMINAL_PROJECT_CONTEXTS,
  useTerminalProjectContextsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { useTerminalAggregateStatus } from "../../features/terminal/use-terminal-aggregate-status";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import { updateTerminalProjectContext } from "../../services/terminal";
import { TerminalAggregateStatus } from "./terminal-aggregate-status";

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
  const { apiBase, scope, token } = useTerminalRuntime();
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const contextsQuery = useTerminalProjectContextsQuery(parentProjectId);
  const contexts =
    contextsQuery.data ?? EMPTY_TERMINAL_PROJECT_CONTEXTS;
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const { byContextProjectId } = useTerminalAggregateStatus();
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(railCollapsedStorageKey(scope)) === "true",
  );
  const [width, setWidth] = useState(() => readRailWidth(scope));
  const [resizing, setResizing] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
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

  if (contexts.length <= 1) {
    return null;
  }

  return (
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
  );
}
