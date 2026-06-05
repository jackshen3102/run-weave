export type SubmitMode = "quick" | "clean-pr" | "force-lease" | "yolo";

export const SUBMIT_MODES: Array<{ value: SubmitMode; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "clean-pr", label: "Clean PR" },
  { value: "force-lease", label: "Force Lease" },
  { value: "yolo", label: "Yolo" },
];

interface BuildSubmitPromptOptions {
  mode: SubmitMode;
  includeAll: boolean;
  base: string;
  branch: string;
  notes: string;
  cwd: string | null;
}

export function buildSubmitPrompt(options: BuildSubmitPromptOptions): string {
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

export function buildTerminalSubmitInput(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
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
  return SUBMIT_MODES.find((item) => item.value === mode)?.label ?? mode;
}
