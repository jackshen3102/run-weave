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
  connectionStatus?: string;
  runtimeStatus?: string | null;
  activeTab?: string;
}

export interface SupportLogRedactionReport {
  tokens: number;
  cookies: number;
  authorizationHeaders: number;
  sensitiveUrls: number;
}

export interface SupportLogBundle {
  manifest: {
    bundleVersion: 1;
    createdAt: string;
    appVersion: string;
    platform: string;
    route?: string;
    scope: SupportLogScope;
    eventCount: number;
  };
  logs: SupportLogRecord[];
  redactionReport: SupportLogRedactionReport;
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
  appVersion: string;
  platform: string;
  route?: string;
  apiBaseHost?: string;
  online?: boolean;
  userAgent?: string;
}
