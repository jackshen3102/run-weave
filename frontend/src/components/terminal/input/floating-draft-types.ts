import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { ClientMode } from "../../../features/client-mode";

export interface FloatingDraftState {
  draft: string;
  synced: string;
  dirty: boolean;
  error: string | null;
  mirrorUnreliable: boolean;
}

export interface UseTerminalFloatingDraftControllerOptions {
  active: boolean;
  activeCommand: string | null;
  apiBase: string;
  bufferType: "normal" | "alternate" | undefined;
  clientMode: ClientMode;
  error: string | null;
  paneWorkspace: TerminalPanelWorkspace | null;
  searchOpen: boolean;
  scrollToBottom: () => void;
  sessionStatus: "running" | "exited";
  showScrollToBottomControl: boolean;
  terminalAtBottom: boolean;
  terminalSessionId: string;
  terminalState?: TerminalState;
  token: string;
}
