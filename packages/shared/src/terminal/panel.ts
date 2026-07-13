import type { TerminalLastThreadStatus } from "./session";
import type { TerminalAgentKind, TerminalState } from "./state";

export type TerminalPanelRole = string;

export const TERMINAL_PANEL_ROLE_SUGGESTIONS = [
  "main",
  "server",
  "tests",
  "planner",
  "reviewer",
  "worker",
] as const;

export interface TerminalPanelGeometry {
  /** Pane position/size in tmux cell units. */
  paneLeft: number;
  paneTop: number;
  paneWidth: number;
  paneHeight: number;
  /** Enclosing tmux window size in cell units. */
  windowWidth: number;
  windowHeight: number;
}

export interface TerminalPanelListItem {
  panelId: string;
  terminalSessionId: string;
  alias: string | null;
  role?: TerminalPanelRole | null;
  threadId?: string;
  threadProvider?: TerminalAgentKind;
  preview?: string;
  lastThreadId?: string;
  lastThreadProvider?: TerminalAgentKind;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: string;
  cwd: string;
  activeCommand: string | null;
  terminalState?: TerminalState;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  focused: boolean;
  tmuxPaneId?: string;
  geometry?: TerminalPanelGeometry;
}

export interface TerminalPanelWorkspace {
  terminalSessionId: string;
  activePanelId: string;
  panels: TerminalPanelListItem[];
  renderMode: "tmux-native";
}

export interface CreateTerminalPanelRequest {
  sourcePanelId?: string;
  direction: "right" | "down";
  alias?: string | null;
  role?: TerminalPanelRole | null;
  command?: string;
  args?: string[];
  cwd?: string;
  focus?: boolean;
}

export interface UpdateTerminalPanelRequest {
  focus?: boolean;
}

export type TerminalPanelResizeDirection = "left" | "right" | "up" | "down";

/**
 * Resize a panel by nudging its shared tmux divider `cells` cells toward
 * `direction`. `left`/`right` move the vertical divider (columns); `up`/`down`
 * move a horizontal divider (rows). Used by the pane resize handle drag
 * interaction.
 */
export interface ResizeTerminalPanelRequest {
  direction: TerminalPanelResizeDirection;
  /** Number of tmux cells to grow (positive) the pane toward `direction`. */
  cells: number;
}
