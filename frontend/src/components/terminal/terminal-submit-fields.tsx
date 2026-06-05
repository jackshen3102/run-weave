import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { SUBMIT_MODES, type SubmitMode } from "./terminal-submit-prompt";

interface TerminalSubmitModeTabsProps {
  mode: SubmitMode;
  onModeChange: (mode: SubmitMode) => void;
}

export function TerminalSubmitModeTabs({
  mode,
  onModeChange,
}: TerminalSubmitModeTabsProps) {
  return (
    <div
      className="grid h-8 grid-cols-4 overflow-hidden rounded-md border border-slate-800 bg-slate-900"
      role="tablist"
      aria-label="Git submit mode"
    >
      {SUBMIT_MODES.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={mode === item.value}
          className={[
            "min-w-0 px-2 text-[11px] font-medium text-slate-300 transition-colors",
            mode === item.value
              ? "bg-sky-500 text-white"
              : "hover:bg-slate-800 hover:text-slate-100",
          ].join(" ")}
          onClick={() => {
            onModeChange(item.value);
          }}
        >
          <span className="block truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

interface TerminalSubmitContextDetailsProps {
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
}

export function TerminalSubmitContextDetails({
  activeProject,
  activeSession,
}: TerminalSubmitContextDetailsProps) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-5">
      <span className="text-slate-500">Target</span>
      <span className="truncate text-sky-300">active AI terminal</span>
      <span className="text-slate-500">Project</span>
      <span className="truncate text-slate-300" title={activeProject?.path ?? ""}>
        {activeProject?.path ?? "Unavailable"}
      </span>
      <span className="text-slate-500">Terminal cwd</span>
      <span className="truncate text-slate-300" title={activeSession?.cwd ?? ""}>
        {activeSession?.cwd ?? "No active terminal"}
      </span>
    </div>
  );
}
