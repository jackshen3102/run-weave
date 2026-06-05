import { useMemo, useState } from "react";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { Check, Clipboard, GitBranch, Send } from "lucide-react";
import { sendTerminalInput } from "../../services/terminal";
import { Button } from "../ui/button";
import {
  buildTerminalSubmitInput,
  buildSubmitPrompt,
  SUBMIT_MODES,
  type SubmitMode,
} from "./terminal-submit-prompt";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";

interface TerminalSubmitPopoverProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  disabled?: boolean;
}

export function TerminalSubmitPopover({
  apiBase,
  token,
  activeProject,
  activeSession,
  disabled,
}: TerminalSubmitPopoverProps) {
  const [mode, setMode] = useState<SubmitMode>("quick");
  const [includeAll, setIncludeAll] = useState(false);
  const [base, setBase] = useState("main");
  const [branch, setBranch] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const prompt = useMemo(
    () =>
      buildSubmitPrompt({
        mode,
        includeAll,
        base,
        branch,
        notes,
        cwd: activeSession?.cwd ?? null,
      }),
    [activeSession?.cwd, base, branch, includeAll, mode, notes],
  );
  const canSend =
    !disabled &&
    !sending &&
    Boolean(activeSession?.terminalSessionId);

  async function handleSend(): Promise<void> {
    if (!activeSession?.terminalSessionId || !canSend) {
      return;
    }
    setSending(true);
    setFeedback(null);
    try {
      await sendTerminalInput(
        apiBase,
        token,
        activeSession.terminalSessionId,
        { data: `${buildTerminalSubmitInput(prompt)}\n` },
      );
      setFeedback("Sent");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(prompt);
      setFeedback("Copied");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label="Git Submit"
          title="Git Submit"
          className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
        >
          <GitBranch className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] rounded-lg border-slate-800 bg-slate-950 p-3 text-slate-100 shadow-[0_24px_80px_-34px_rgba(2,6,23,0.95)]"
      >
        <div className="flex flex-col gap-3" data-testid="terminal-submit-popover">
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
                  setMode(item.value);
                }}
              >
                <span className="block truncate">{item.label}</span>
              </button>
            ))}
          </div>

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

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Notes
            <textarea
              className="min-h-16 resize-none rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-600"
              placeholder="Optional constraints for the agent"
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              Base
              <input
                className="h-8 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-600 disabled:opacity-50"
                disabled={mode === "quick" || mode === "yolo"}
                value={base}
                onChange={(event) => {
                  setBase(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              Branch
              <input
                className="h-8 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-600 disabled:opacity-50"
                disabled={mode !== "clean-pr"}
                placeholder="codex/topic"
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value);
                }}
              />
            </label>
          </div>

          <label className="flex h-7 items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={includeAll || mode === "yolo"}
              disabled={mode === "yolo"}
              className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-900"
              onChange={(event) => {
                setIncludeAll(event.target.checked);
              }}
            />
            Include all changes
          </label>

          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] leading-4 text-slate-300"
            data-testid="terminal-submit-prompt"
          >
            {prompt}
          </pre>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canSend}
              className="h-8 flex-1 gap-1.5 rounded-md px-2 text-xs"
              data-testid="terminal-submit-send"
              onClick={() => void handleSend()}
            >
              <Send className="h-3.5 w-3.5" />
              Send to AI
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 w-9 rounded-md px-0"
              aria-label="Copy Git Submit prompt"
              title="Copy"
              onClick={() => void handleCopy()}
            >
              <Clipboard className="h-3.5 w-3.5" />
            </Button>
          </div>

          {!canSend ? (
            <p className="text-[11px] leading-4 text-amber-300">
              Active terminal is required.
            </p>
          ) : null}
          {feedback ? (
            <p className="inline-flex items-center gap-1 text-[11px] leading-4 text-slate-300">
              {feedback === "Sent" || feedback === "Copied" ? (
                <Check className="h-3 w-3 text-emerald-300" />
              ) : null}
              {feedback}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
