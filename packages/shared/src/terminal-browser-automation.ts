import type { TerminalBrowserProfileId } from "./terminal-browser-profile";

export type TerminalBrowserAutomationActor =
  | { kind: "terminal"; terminalSessionId: string }
  | { kind: "unattributed"; connectionId: string };

export type TerminalBrowserAutomationActionKind =
  | "idle"
  | "click"
  | "input"
  | "scroll"
  | "navigate"
  | "reload";

export interface TerminalBrowserAutomationConnectionSnapshot {
  connectionId: string;
  actor: TerminalBrowserAutomationActor;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string | null;
  connectedAt: number;
  attachedTargetIds: string[];
}

export interface TerminalBrowserAutomationTargetSnapshot {
  targetId: string;
  tabId: string;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string;
  title: string;
  url: string;
  faviconDataUrl: string | null;
  loading: boolean;
  viewportWidth: number;
  viewportHeight: number;
  actorKeys: string[];
  action: TerminalBrowserAutomationActionKind;
  actionUntil: number | null;
  pointer: { x: number; y: number } | null;
  previewState: "idle" | "connecting" | "live" | "error";
  previewError: string | null;
}

export interface TerminalBrowserAutomationSnapshot {
  revision: number;
  connections: TerminalBrowserAutomationConnectionSnapshot[];
  targets: TerminalBrowserAutomationTargetSnapshot[];
}

export interface TerminalBrowserAutomationViewStateRequest {
  visible: boolean;
  selectedTargetId: string | null;
  mainMaxEdge: number;
}

export interface TerminalBrowserAutomationFrameAcknowledgeRequest {
  targetId: string;
  sequence: number;
}

export interface TerminalBrowserAutomationFrame {
  targetId: string;
  sequence: number;
  capturedAt: number;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  bytes: Uint8Array;
}
