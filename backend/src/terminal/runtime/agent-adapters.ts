import { buildAgentResumeArgs } from "@runweave/shared/terminal/agent-resume";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
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
        await tmux.sendKeySequence(target, [{ type: "key", key: "Enter" }]);
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
}): string {
  const args = [
    ...(thread.provider === "codex" ? CODEX_SKIP_UPDATE_ON_STARTUP_ARGS : []),
    ...buildAgentResumeArgs(
      thread.provider,
      thread.sessionFile ?? thread.threadId,
    ),
  ];
  return `${thread.provider} ${args.map(shellQuote).join(" ")}\n`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
