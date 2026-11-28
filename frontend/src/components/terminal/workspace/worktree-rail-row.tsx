import { Fragment } from "react";
import type { TerminalBrowserProfilePreferences } from "@runweave/shared/terminal-browser-profile";
import type {
  TerminalProjectContextBranchStatus,
  TerminalProjectContextListItem,
  WorktreeGovernanceItem,
} from "@runweave/shared/terminal/project-context";
import { Pin, RotateCcw, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import { TerminalAggregateStatus } from "./aggregate-status";
import { WorktreeBranchStatus } from "./worktree-branch-status";

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

export interface WorktreeRailRowProps {
  context: TerminalProjectContextListItem;
  active: boolean;
  status: number;
  governance?: WorktreeGovernanceItem;
  branchStatus?: TerminalProjectContextBranchStatus;
  branchStatusFailed: boolean;
  profilePreferences: TerminalBrowserProfilePreferences | null;
  pinPending: boolean;
  onSelect: (projectId: string) => void;
  onTogglePinned: (projectId: string, pinned: boolean) => void;
  onRecycle: (projectId: string) => void;
  onDelete: (context: TerminalProjectContextListItem) => void;
}

export function WorktreeRailRow({
  context,
  active,
  status,
  governance,
  branchStatus,
  branchStatusFailed,
  profilePreferences,
  pinPending,
  onSelect,
  onTogglePinned,
  onRecycle,
  onDelete,
}: WorktreeRailRowProps) {
  const unavailable = context.availability !== "available";
  const browserPreference = profilePreferences?.worktrees[context.projectId];
  const browserProfileId =
    browserPreference?.preferredProfileId ??
    profilePreferences?.defaultProfileId;
  const browserSummary = browserProfileId
    ? `${browserProfileId.replace("profile-", "P")} · ${
        browserPreference?.preferredProfileId ? "bound" : "global"
      }`
    : null;

  const row = (
    <div
      data-testid="terminal-worktree-row"
      data-project-id={context.projectId}
      data-active={active ? "true" : "false"}
      data-bucket={
        governance?.bucket ?? (context.isPrimary ? "primary" : "unknown")
      }
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
        onClick={() => onSelect(context.projectId)}
      >
        <span className="min-w-0 flex-1">
          <TerminalAggregateStatus
            label={context.name}
            status={status}
            className="flex w-full"
            labelClassName="min-w-0 flex-1 truncate text-xs font-semibold"
          />
          <span className="flex items-center justify-between gap-2">
            <span
              title={getContextDetail(context)}
              className={[
                "min-w-0 truncate text-[10px]",
                unavailable ? "text-amber-400" : "text-slate-500",
              ].join(" ")}
            >
              {getContextDetail(context)}
            </span>
            {!unavailable ? (
              <WorktreeBranchStatus
                status={branchStatus}
                failed={branchStatusFailed}
              />
            ) : null}
          </span>
          {governance?.bucket === "idle_hot_slot" ? (
            <span className="block truncate text-[9px] text-emerald-400">
              空闲槽位 · 可秒复用
            </span>
          ) : null}
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
          title="主目录：永久置顶保护"
          className="flex h-6 w-6 shrink-0 items-center justify-center text-sky-400"
        >
          <Pin className="h-3.5 w-3.5 fill-current" />
        </span>
      ) : (
        <button
          type="button"
          aria-label={context.pinned ? "Unpin Worktree" : "Pin Worktree"}
          title={
            context.pinned
              ? "已置顶保护（不折叠、不自动删除，空闲干净时可复用）"
              : "Pin Worktree"
          }
          disabled={pinPending}
          className={[
            "flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40",
            context.pinned ? "text-sky-400" : "text-slate-600",
          ].join(" ")}
          onClick={() => onTogglePinned(context.projectId, !context.pinned)}
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
    return <Fragment>{row}</Fragment>;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {!unavailable ? (
          <ContextMenuItem
            data-testid="terminal-worktree-recycle-menu-item"
            disabled={governance?.canRecycle !== true}
            className="gap-2 text-sky-400 focus:text-sky-300"
            onSelect={() => onRecycle(context.projectId)}
          >
            <RotateCcw className="h-4 w-4" />
            {governance?.canRecycle
              ? "原地重置复用"
              : "原地重置复用（需干净已合入）"}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          data-testid="terminal-worktree-delete-menu-item"
          disabled={context.pinned}
          className="gap-2 text-rose-400 focus:text-rose-400"
          onSelect={() => onDelete(context)}
        >
          <Trash2 className="h-4 w-4" />
          {context.pinned ? "已置顶保护（不可删除）" : "删除"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
