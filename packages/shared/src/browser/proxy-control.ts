import type { TerminalBrowserProfileRuntimeState } from "./profile";

export interface BrowserProxyState extends TerminalBrowserProfileRuntimeState {
  scope: "profile";
  appliesTo: "future-requests";
  pagesReloaded: false;
  /** Electron's actual proxy resolution for a fixed external HTTPS probe. */
  effectiveProxy: string;
}
