export type TerminalBrowserFindCommand =
  | { action: "open" | "close" | "next" | "previous" }
  | { action: "search"; query: string };

export interface TerminalBrowserFindState {
  tabId: string;
  open: boolean;
  query: string;
  matches: number;
  activeMatchOrdinal: number;
  /** Increases only when the user requests focus in the find input. */
  focusRevision: number;
  revision: number;
}
