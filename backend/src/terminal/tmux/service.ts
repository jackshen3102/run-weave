import { TmuxPaneService } from "./pane-service";

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

export class TmuxService extends TmuxPaneService {}
