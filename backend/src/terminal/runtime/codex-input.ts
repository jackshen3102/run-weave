import { splitClipboardImagePaste } from "./clipboard-image-paste";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CodexInputContext } from "@runweave/shared/terminal/codex-context";
import type { TerminalPromptSubmitKey } from "@runweave/shared/terminal/input";
import type { TerminalPanelRecord } from "../manager/manager";
import type { TmuxPaneTarget, TmuxService } from "../tmux/service";
import { codexContextPath, readCodexContext } from "./codex-context";

/** Native TUI validates identity and edits its composer atomically on its own event loop. */
export async function replaceManagedCodexPrompt(options: {
  panel: TerminalPanelRecord;
  target: TmuxPaneTarget;
  tmux: TmuxService;
  expected?: CodexInputContext;
  supervisor: boolean;
  text: string;
  submit: boolean;
  append?: boolean;
  submitKey: TerminalPromptSubmitKey | "auto";
}): Promise<void> {
  const context = readCodexContext(options.panel).context;
  if (!context?.displayedThreadId || !context.inputReady || context.closed)
    throw new Error("Codex 输入上下文尚未就绪，草稿已保留。");
  if (options.supervisor && context.displayedThreadId !== context.primaryThreadId)
    throw new Error("旁聊正在显示，主任务续接暂不写入终端。");
  const expected = options.expected ?? { generation: context.generation, revision: context.revision, threadId: context.displayedThreadId };
  if (expected.generation !== context.generation || expected.revision !== context.revision || expected.threadId !== context.displayedThreadId)
    throw new Error("Codex 会话或原生草稿已变化，未发送，草稿已保留。");
  const requestId = randomUUID();
  const directory = path.dirname(codexContextPath(options.panel.terminalSessionId, options.panel.id));
  const requestPath = path.join(directory, `input-${requestId}.json`);
  const responsePath = path.join(directory, `input-${requestId}.result.json`);
  try {
    await writeFile(requestPath, JSON.stringify({ ...expected, text: options.text, segments: splitClipboardImagePaste(options.text), append: options.append === true, submit: options.submit, submitKey: options.submitKey, expiresAt: Date.now() + 10_000 }), { flag: "wx", mode: 0o600 });
    await options.tmux.cancelCopyMode(options.target, { strict: true });
    await options.tmux.sendKeySequence(options.target, [{ type: "literal", value: `\x1b[200~RUNWEAVE_CODEX_INPUT:${context.generation}:${requestId}\x1b[201~` }]);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      let response: { requestId?: string; generation?: string; accepted?: boolean } | null = null;
      try { response = JSON.parse(await readFile(responsePath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (response?.requestId === requestId && response.generation === context.generation) {
        if (!response.accepted) throw new Error("Codex 已切换会话或草稿，未发送；请核对原终端，草稿已保留。");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Codex 输入回执未确认，草稿已保留；请检查原终端，不要自动重发。");
  } finally {
    await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
  }
}
