import type {
  AgentTeamAcceptanceCase,
  AgentTeamExportHistoryMode,
  AgentTeamVerificationConfig,
} from "@runweave/shared/agent-team";
import type { TerminalSessionManager } from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import type { TerminalActivityDependencies } from "../terminal/activity-events";

export interface AgentTeamServiceOptions {
  terminalSessionManager: TerminalSessionManager;
  terminalEventService: TerminalEventService;
  ptyService: PtyService;
  runtimeRegistry: TerminalRuntimeRegistry;
  terminalStateService: TerminalStateService;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  cwd?: string;
  activity?: TerminalActivityDependencies;
}

export type AgentTeamCompletionSignalSource =
  | "terminal_event"
  | "app_server"
  | "startup"
  | "watchdog";

export interface AgentTeamCompletionSignal {
  projectId: string;
  terminalSessionId: string;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  cwd?: string | null;
  outboxPath?: string | null;
  source: AgentTeamCompletionSignalSource;
}

export interface ExportAgentTeamRunOptions {
  history?: AgentTeamExportHistoryMode;
  tailLines?: number;
  includeSessionOther?: boolean;
  includeOutboxes?: boolean;
}

export interface PreparedAgentTeamAcceptance {
  verification: AgentTeamVerificationConfig;
  acceptance: AgentTeamAcceptanceCase[];
  startLog: string;
}
