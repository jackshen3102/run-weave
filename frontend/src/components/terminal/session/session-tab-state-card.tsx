import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalProgramStatus } from "@runweave/shared/terminal/program-status";
import { programStatusLabels } from "../../../features/terminal/state/program-status";

function getTerminalStateLabel(
  session: TerminalSessionListItem,
  terminalState?: TerminalState,
): string {
  if (session.status === "exited") {
    return "Exited";
  }
  if (!terminalState) {
    return "Status unavailable";
  }
  if (terminalState.state === "agent_running") {
    return "Agent running";
  }
  if (terminalState.state === "agent_starting") {
    return "Agent starting";
  }
  if (terminalState.state === "agent_idle") {
    return "Agent idle";
  }
  return "Shell idle";
}

function getTerminalStateDetail(
  session: TerminalSessionListItem,
  terminalState?: TerminalState,
): string {
  if (session.status === "exited") {
    return "Terminal exited";
  }
  if (!terminalState) {
    return "Waiting for state";
  }
  if (terminalState.state === "agent_running") {
    return "Model response in progress";
  }
  if (terminalState.state === "agent_starting") {
    return "Starting agent";
  }
  if (terminalState.state === "agent_idle") {
    return "Waiting for input";
  }
  return "Shell ready";
}

function formatCommandForDisplay(session: TerminalSessionListItem): string {
  const command = session.activeCommand?.trim() || session.command.trim();
  if (!command) {
    return "-";
  }
  const args = session.activeCommand?.trim() ? [] : session.args;
  return [command, ...args].join(" ");
}

function formatActivityTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "Just now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function TerminalTabStateDot({
  session,
  terminalState,
}: {
  session: TerminalSessionListItem;
  terminalState?: TerminalState;
}) {
  if (session.status === "exited") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-slate-600 bg-slate-800"
      />
    );
  }
  if (!terminalState) {
    return null;
  }
  if (terminalState.state === "agent_running") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-cyan-200 bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.75)] motion-safe:animate-pulse"
      />
    );
  }
  if (terminalState.state === "agent_starting") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-amber-200 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55)] motion-safe:animate-pulse"
      />
    );
  }
  if (terminalState.state === "agent_idle") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-sky-500"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full border border-slate-500 bg-transparent"
    />
  );
}

export function TerminalTabStateCard({
  session,
  terminalState,
  programStatus,
}: {
  session: TerminalSessionListItem;
  terminalState?: TerminalState;
  programStatus?: TerminalProgramStatus;
}) {
  const stateLabel = programStatus ? programStatusLabels[programStatus.state] : getTerminalStateLabel(session, terminalState);
  const detail = programStatus?.source === "osc" ? programStatus.kind : getTerminalStateDetail(session, terminalState);
  return (
    <div className="space-y-2 text-xs text-slate-300">
      <div className="flex items-center gap-2">
        {programStatus?.source !== "osc" ? <TerminalTabStateDot session={session} terminalState={terminalState} /> : null}
        <div className="min-w-0">
          <div className="font-medium text-slate-100">{stateLabel}</div>
          {detail ? <div className="truncate text-slate-400">{detail}</div> : null}
        </div>
      </div>
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <span className="text-slate-500">Agent</span>
        <span className="truncate text-slate-200">
          {terminalState?.agent ?? "-"}
        </span>
        <span className="text-slate-500">Command</span>
        <span className="truncate text-slate-200">
          {formatCommandForDisplay(session)}
        </span>
        <span className="text-slate-500">Activity</span>
        <span className="truncate text-slate-200">
          {formatActivityTime(session.lastActivityAt)}
        </span>
      </div>
    </div>
  );
}
