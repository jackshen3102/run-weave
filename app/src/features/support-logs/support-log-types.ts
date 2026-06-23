export type SupportLogLevel = "debug" | "info" | "warn" | "error";

export interface SupportLogRecord {
  at: string;
  level: SupportLogLevel;
  source: "app";
  event: string;
  fields?: Record<string, unknown>;
}

export interface SupportLogScope {
  source: "login" | "home" | "terminal" | "unknown";
  route?: string;
  terminalSessionId?: string;
  projectId?: string | null;
  connectionId?: string | null;
  connectionName?: string | null;
  connectionStatus?: string;
  runtimeStatus?: string | null;
  activeTab?: string;
}

export interface SupportLogStoreStatus {
  storageDegraded: boolean;
  storageKind: "indexeddb" | "memory";
}

export interface SupportLogStore {
  append(record: SupportLogRecord): Promise<void>;
  listRecent(options?: { since?: Date; limit?: number }): Promise<SupportLogRecord[]>;
  clear(): Promise<void>;
  getStatus(): SupportLogStoreStatus;
}

export interface SupportLogDefaultContext {
  appBuildId: string;
  appVersion: string;
  platform: string;
  route?: string;
  apiBaseHost?: string;
  online?: boolean;
  userAgent?: string;
}
