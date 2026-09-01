import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

export interface TerminalBrowserControllerOptions {
  active: boolean;
  nativeViewSuppressed: boolean;
  profileId: TerminalBrowserProfileId;
  activationProjectId: string | null;
  activationRevision: number;
  apiBase: string;
  token: string;
  terminalSessionId: string | null;
}
