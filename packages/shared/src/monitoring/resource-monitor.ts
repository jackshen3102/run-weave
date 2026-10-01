import type { SystemMonitorSnapshot } from "./system";

export interface ResourceMonitorSettings {
  revision: number;
  monitorEnabled: boolean;
  alertsEnabled: boolean;
}
export type ResourceRule = "energy" | "memory";
export interface ResourceAlert {
  alertId: string;
  hostId: string;
  appKey: string;
  appName: string;
  ruleId: ResourceRule;
  firstAt: number;
  lastAt: number;
  mean: number;
  sampleCount: number;
  active: boolean;
  snoozedUntil: number;
  createdAt: number;
}
export interface ResourceMonitorResponse {
  hostId: string;
  hostName: string;
  streamId: string;
  revision: number;
  sampleAgeMs: number | null;
  status: "ok" | "warming-up" | "stale" | "error" | "disabled" | "unsupported";
  snapshot: SystemMonitorSnapshot | null;
  settings: ResourceMonitorSettings;
  alerts: ResourceAlert[];
  coverage: {
    knownProcesses: number;
    matchedProcesses: number;
    complete: boolean;
  };
  cpuSource: "native-minute-delta";
  canTerminate: boolean;
}
export interface TerminateProcessRequest {
  requestId: string;
  force: boolean;
}
export interface TerminateProcessResult {
  requestId: string;
  processInstanceId: string;
  state: "exited" | "already_exited" | "still_running";
  forceAllowed: boolean;
  message: string;
}
export interface ResourceNotificationTarget {
  connectionId: string;
  hostId: string;
  alertId: string;
  appKey: string;
  title: string;
  body: string;
}
