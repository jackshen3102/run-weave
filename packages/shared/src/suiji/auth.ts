import type { SUIJI_LIMITS } from "./limits";
export type SuijiIdentity = { ownerId: string; serverId: string };
export type SuijiTokens = SuijiIdentity & {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
};
export type SuijiInfo = SuijiIdentity & {
  features?: {
    browse?: boolean;
    materials?: boolean;
    workMaterials?: boolean;
    followups: boolean;
    changes?: boolean;
    workRecords?: boolean;
    workReports?: boolean;
    workSources?: boolean;
    workBrowserHistory?: boolean;
    workScreenTimeline?: boolean;
    correction?: boolean;
    correctionHistory?: boolean;
  };
  protocolVersion: 1;
  appVersion: string;
  schemaVersion: number;
  limits: typeof SUIJI_LIMITS;
  ai?: { enabled: boolean; provider: "codex-cli" | "disabled" };
};
