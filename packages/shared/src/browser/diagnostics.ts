import type { TerminalBrowserProfileId, TerminalBrowserProfileProxyMode } from "./profile";

export type BrowserDiagnosticStage = "identity" | "binding" | "cdp" | "proxy";

/** Control-path proof only; never includes capabilities, CDP tickets or page URLs. */
export interface BrowserDiagnosticReport {
  schemaVersion: 1;
  scope: "terminal-browser-control";
  healthy: boolean;
  observedAt: string;
  cliVersion: string;
  checks: {
    stage: BrowserDiagnosticStage;
    status: "passed" | "failed" | "skipped";
    code?: string;
  }[];
  profileId?: TerminalBrowserProfileId;
  proxyMode?: TerminalBrowserProfileProxyMode;
  effectiveProxy?: string;
  pageRequestsVerified: false;
}

export interface BrowserRecoveryReport extends BrowserDiagnosticReport {
  action: "none" | "requested";
  recoveryStatus?: "pending" | "rebuilding" | "complete";
  recoveryCode?: string;
}

export interface BrowserRecoveryAccepted {
  protocolVersion: 2;
  requestId: string;
  requestedAt: number;
  status: "pending" | "rebuilding" | "complete";
}
