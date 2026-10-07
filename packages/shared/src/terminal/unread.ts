/** Absolute count of terminals whose completion has not been acknowledged. */
export interface TerminalUnreadSnapshot {
  hostId: string;
  revision: number;
  count: number;
}

/** Main-renderer supplied credentials; retained only in Electron main memory. */
export interface TerminalBadgeConnection {
  id: string;
  url: string;
  token: string | null;
}
