import { buildAgentResumeArgs } from "@runweave/shared/terminal/agent-resume";
import { terminalShellName } from "@runweave/shared/terminal/shell";
import { settingText } from "@runweave/config-node";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import type { TerminalPromptSubmitKey } from "@runweave/shared/terminal/input";
import type { PiAgentContext } from "@runweave/shared/terminal/pi-agent";
import type { TmuxPaneTarget, TmuxService } from "../tmux/service";
import { replacePiEditor } from "./pi-editor";
import { resolvePiResumeFile } from "./pi-session";

interface PromptContext {
  target: TmuxPaneTarget;
  tmux: TmuxService;
  terminalSessionId: string;
  pi?: PiAgentContext;
  requestId: string;
  text: string;
  submit: boolean;
  submitKey?: TerminalPromptSubmitKey;
}

interface AgentAdapter {
  /** Absence means the terminal's existing key-sequence input protocol. */
  replacePrompt?: (context: PromptContext) => Promise<void>;
  resolveResumeTarget: (
    threadId: string,
    pi?: PiAgentContext,
  ) => Promise<string>;
}

const inputOwners = new Set<string>();
const terminalAdapter: AgentAdapter = {
  resolveResumeTarget: async (threadId) => threadId,
};
const piAdapter: AgentAdapter = {
  resolveResumeTarget: resolvePiResumeFile,
  async replacePrompt({
    target,
    tmux,
    terminalSessionId,
    pi,
    requestId,
    text,
    submit,
    submitKey = "Enter",
  }) {
    if (!pi)
      throw new Error("Pi pane identity unavailable; draft was retained");
    const ownerKey = `${target.socketPath}:${target.paneId}`;
    if (inputOwners.has(ownerKey))
      throw new Error("Pi input is busy; draft was retained");
    inputOwners.add(ownerKey);
    try {
      await tmux.cancelCopyMode(target, { strict: true });
      await replacePiEditor(target, {
        version: 1,
        terminalSessionId,
        threadId: pi.sessionId,
        instanceId: pi.instanceId,
        requestId,
        text,
      });
      if (submit)
        await tmux.sendKeySequence(target, [{ type: "key", key: submitKey }]);
    } finally {
      inputOwners.delete(ownerKey);
    }
  },
};

// Static host adapters; provider files and process control remain in Backend.
const adapters: Record<string, AgentAdapter> = {
  codex: terminalAdapter,
  trae: terminalAdapter,
  traecli: terminalAdapter,
  traex: terminalAdapter,
  pi: piAdapter,
};
export function getAgentAdapter(
  agent: string | null | undefined,
): AgentAdapter {
  return (agent && adapters[agent]) || terminalAdapter;
}

const CODEX_SKIP_UPDATE_ON_STARTUP_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;

export function buildAgentResumeCommand(thread: {
  provider: TerminalAgentKind;
  threadId: string;
  sessionFile?: string;
  executable?: string;
  shell?: string;
}): string {
  const args = [
    ...(thread.provider === "codex" ? CODEX_SKIP_UPDATE_ON_STARTUP_ARGS : []),
    ...buildAgentResumeArgs(
      thread.provider,
      thread.sessionFile ?? thread.threadId,
    ),
  ];
  const configured = thread.provider === "codex"
    ? settingText("agents.codex.binary")?.trim()
    : ["trae", "traex", "traecli"].includes(thread.provider)
      ? settingText("agents.traex.binary")?.trim()
      : undefined;
  const executable = thread.executable ?? configured ?? thread.provider;
  const shell = terminalShellName(thread.shell ?? "sh");
  if (["powershell", "pwsh", "cmd"].includes(shell)) {
    const parts = [executable, ...args];
    if (parts.some(part => [...part].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
      throw new Error("Agent resume arguments contain terminal control characters");
    const command = `& ${parts.map(part => `'${part.replaceAll("'", "''")}'`).join(" ")}`;
    return shell === "cmd"
      ? `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}\n`
      : `${command}\n`;
  }
  return `${shellQuote(executable)} ${args.map(shellQuote).join(" ")}\n`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
