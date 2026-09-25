import { TmuxPaneService } from "./pane-service";
import type { TmuxPaneTarget } from "./types";

export type {
  KillOrphanedTmuxSessionsOptions,
  TmuxAvailability,
  TmuxCommand,
  TmuxExecFile,
  TmuxKeySequenceItem,
  TmuxLaunchCommand,
  TmuxPaneInfo,
  TmuxPaneMetadata,
  TmuxPaneTarget,
  TmuxRebuildAttempt,
  TmuxServiceOptions,
  TmuxSessionInfo,
  TmuxTarget,
} from "./types";
export {
  TMUX_AGENT_PREPARE_COMMAND_OPTION,
  TMUX_AGENT_PREPARE_EXIT_OPTION,
  TmuxRebuildLimitError,
} from "./types";

export class TmuxService extends TmuxPaneService {
  /** Keep SGR attributes to distinguish a dim TUI placeholder from user input. */
  async capturePaneWithAnsi(target: TmuxPaneTarget): Promise<string> {
    if (!/^%\d+$/.test(target.paneId)) throw new Error("Invalid pane target");
    const result = await this.runTmux(
      ["capture-pane", "-p", "-e", "-J", "-S", "-0", "-t", target.paneId],
      target,
      { sensitiveOutput: true },
    );
    return result.stdout.replace(/\r\n/g, "\n");
  }
}
