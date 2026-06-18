import type { TerminalSessionListItem } from "@runweave/shared";
import { formatTerminalSessionName } from "../../../features/terminal/session-name";

export function BindingControls(props: {
  mode: "new" | "reuse";
  sessionId: string;
  sessions: TerminalSessionListItem[];
  onModeChange: (mode: "new" | "reuse") => void;
  onSessionChange: (sessionId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
      <label className="inline-flex items-center gap-1">
        <input
          type="radio"
          checked={props.mode === "new"}
          onChange={() => props.onModeChange("new")}
        />
        新建终端
      </label>
      <label className="inline-flex items-center gap-1">
        <input
          type="radio"
          checked={props.mode === "reuse"}
          onChange={() => props.onModeChange("reuse")}
        />
        复用
      </label>
      <select
        value={props.sessionId}
        disabled={props.mode !== "reuse"}
        onChange={(event) => props.onSessionChange(event.target.value)}
        className="h-7 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600 disabled:opacity-50"
      >
        <option value="">选择终端</option>
        {props.sessions.map((session) => (
          <option key={session.terminalSessionId} value={session.terminalSessionId}>
            {formatTerminalSessionName({
              alias: session.alias,
              cwd: session.cwd,
              activeCommand: session.activeCommand,
            })}
          </option>
        ))}
      </select>
    </div>
  );
}
