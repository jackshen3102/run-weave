import { useMemo, useState } from "react";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { Check, Clipboard, GitBranch, Send } from "lucide-react";
import { sendTerminalInput } from "../../services/terminal";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";

type SubmitMode = "quick" | "clean-pr" | "force-lease" | "yolo";

interface TerminalSubmitPopoverProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  disabled?: boolean;
}

const MODES: Array<{ value: SubmitMode; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "clean-pr", label: "Clean PR" },
  { value: "force-lease", label: "Force Lease" },
  { value: "yolo", label: "Yolo" },
];

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
        { data: `${prompt}\n` },
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
            {MODES.map((item) => (
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

function buildSubmitPrompt(options: {
  mode: SubmitMode;
  includeAll: boolean;
  base: string;
  branch: string;
  notes: string;
  cwd: string | null;
}): string {
  const base = options.base.trim();
  const branch = options.branch.trim();
  const modeInstruction = resolveModeInstruction(options.mode, base, branch);
  const stageInstruction =
    options.includeAll || options.mode === "yolo"
      ? "你已被授权使用 git add -A，并纳入所有本地 modified、deleted、renamed 和 untracked 文件。"
      : "请先检查 diff，再只 stage 属于本次提交任务的文件。";
  const notes = options.notes.trim();

  return [
    "请在当前仓库完成这次 Git 提交任务。",
    "",
    `模式：${modeLabel(options.mode)}`,
    `当前终端 cwd：${options.cwd ?? "未知"}`,
    "",
    modeInstruction,
    stageInstruction,
    "",
    "要求：",
    "- 提交前先检查 git status、git diff、staged diff 和最近的提交记录。",
    "- 根据实际代码变更自行总结 commit title 和 message，不要使用固定占位标题。",
    "- 如果 rebase 冲突、lint hook、类型检查或 push hook 失败，请诊断并修复对应问题，然后重试被中断的步骤。",
    "- 禁止使用 git push --force。只有在当前模式明确授权改写历史，或你解释清楚必要性时，才允许使用 --force-with-lease。",
    "- 保留无关的本地改动。除非本次提交任务必须处理，并且你先解释原因，否则不要 revert 用户的工作。",
    "- 完成后汇报分支、commit hash 和 push 结果。",
    notes ? "" : null,
    notes ? `补充说明：${notes}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function resolveModeInstruction(
  mode: SubmitMode,
  base: string,
  branch: string,
): string {
  if (mode === "clean-pr") {
    return [
      `请基于 ${base || "远程默认分支"} 创建或使用一个干净分支${branch ? `（分支名：${branch}）` : ""}。`,
      "把本次需要提交的变更整理到该分支上，保持提交历史干净，然后 push。",
    ].join(" ");
  }
  if (mode === "force-lease") {
    return `请通过 rebase 或其他合适方式把当前分支对齐到 ${base || "目标 base"}；如果确实需要改写远端历史，请使用 --force-with-lease push。`;
  }
  if (mode === "yolo") {
    return "请提交当前 worktree 中的所有本地改动，按需与远端同步，然后 push。";
  }
  return "请总结当前 diff，必要时创建合适的 commit，安全地与远端同步，然后 push。";
}

function modeLabel(mode: SubmitMode): string {
  return MODES.find((item) => item.value === mode)?.label ?? mode;
}
