import type { TerminalSessionManager, TerminalSessionRecord } from "../../terminal/manager";
import type { PtyService } from "../../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../../terminal/runtime-registry";
import type { TmuxOutputWatcher } from "../../terminal/tmux-output-watcher";
import type { TmuxService } from "../../terminal/tmux-service";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  resolveTmuxTarget,
} from "../../terminal/runtime-launcher";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const PROMPT_PASTE_CHUNK_SIZE = 3000;

export class OrchestratorPromptSender {
  constructor(
    private readonly options: {
      terminalSessionManager: TerminalSessionManager;
      ptyService: PtyService;
      runtimeRegistry: TerminalRuntimeRegistry;
      tmuxService?: TmuxService;
      tmuxOutputWatcher?: TmuxOutputWatcher;
    },
  ) {}

  async sendPromptToAgent(
    session: TerminalSessionRecord,
    text: string,
  ): Promise<void> {
    const ensured = await ensureTerminalRuntime({
      session,
      terminalSessionManager: this.options.terminalSessionManager,
      runtimeRegistry: this.options.runtimeRegistry,
      ptyService: this.options.ptyService,
      tmuxService: this.options.tmuxService,
      tmuxOutputWatcher: this.options.tmuxOutputWatcher,
    });
    const pastedPrompt = `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
    if (isTmuxBackedSession(session) && this.options.tmuxService) {
      await this.options.tmuxService.sendKeySequence(
        resolveTmuxTarget(session, this.options.tmuxService),
        [
          ...splitPromptPaste(pastedPrompt).map((value) => ({
            type: "literal" as const,
            value,
          })),
          { type: "key", key: "C-m" },
        ],
      );
      return;
    }
    ensured.runtime.write(`${pastedPrompt}\r`);
  }
}

function splitPromptPaste(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += PROMPT_PASTE_CHUNK_SIZE) {
    chunks.push(value.slice(index, index + PROMPT_PASTE_CHUNK_SIZE));
  }
  return chunks;
}
