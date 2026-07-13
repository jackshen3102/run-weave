export interface TmuxTarget {
  sessionName: string;
  socketPath: string;
}

export interface TmuxPaneTarget extends TmuxTarget {
  paneId: string;
}

export interface TmuxCommand {
  command: string;
  args: string[];
}

export interface TmuxLaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

export interface TmuxPaneMetadata {
  cwd: string;
  activeCommand: string | null;
  activeCommandSource: "runweave_command" | "pane_current_command" | null;
  paneCommand: string | null;
}

export interface TmuxPaneInfo extends TmuxPaneMetadata {
  paneId: string;
  runweavePanelId: string | null;
  paneIndex: number;
  active: boolean;
  paneLeft: number;
  paneTop: number;
  paneWidth: number;
  paneHeight: number;
  windowWidth: number;
  windowHeight: number;
}

export type TmuxKeySequenceItem =
  | { type: "literal"; value: string; delayAfterMs?: number }
  | { type: "key"; key: string; delayAfterMs?: number };

export interface TmuxSessionInfo {
  sessionName: string;
  attachedClients: number;
  windows: number;
}

export interface KillOrphanedTmuxSessionsOptions {
  includeAttached?: boolean;
}

export interface TmuxAvailability {
  available: boolean;
  reason: string | null;
}

export interface TmuxRebuildAttempt {
  allowed: true;
  count: number;
  windowMs: number;
  maxAttempts: number;
}

export type TmuxExecFile = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

export interface TmuxServiceOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  socketDir?: string;
  execFile?: TmuxExecFile;
  now?: () => number;
}
export class TmuxRebuildLimitError extends Error {
  constructor(
    readonly terminalSessionId: string,
    readonly count: number,
    readonly windowMs: number,
    readonly maxAttempts: number,
  ) {
    super(
      `tmux session rebuild exceeded ${maxAttempts} attempts in ${windowMs} ms for ${terminalSessionId}`,
    );
    this.name = "TmuxRebuildLimitError";
  }
}
