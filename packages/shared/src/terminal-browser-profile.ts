export const TERMINAL_BROWSER_PROFILE_IDS = [
  "profile-1",
  "profile-2",
  "profile-3",
] as const;

export type TerminalBrowserProfileId =
  (typeof TERMINAL_BROWSER_PROFILE_IDS)[number];

export const TERMINAL_BROWSER_PROFILE_CONFIGS = {
  "profile-1": {
    id: "profile-1",
    label: "Browser 1",
    shortLabel: "P1",
    partition: "persist:runweave-terminal-browser",
    whistlePort: 8081,
    whistleStorage: "profile-1",
  },
  "profile-2": {
    id: "profile-2",
    label: "Browser 2",
    shortLabel: "P2",
    partition: "persist:runweave-terminal-browser-profile-2",
    whistlePort: 8082,
    whistleStorage: "profile-2",
  },
  "profile-3": {
    id: "profile-3",
    label: "Browser 3",
    shortLabel: "P3",
    partition: "persist:runweave-terminal-browser-profile-3",
    whistlePort: 8083,
    whistleStorage: "profile-3",
  },
} as const satisfies Record<
  TerminalBrowserProfileId,
  {
    id: TerminalBrowserProfileId;
    label: string;
    shortLabel: string;
    partition: string;
    whistlePort: number;
    whistleStorage: string;
  }
>;

export const TERMINAL_BROWSER_DEFAULT_PROFILE_ID: TerminalBrowserProfileId =
  "profile-1";
export const TERMINAL_BROWSER_RESERVED_WHISTLE_VALUE = "runweave-dev-server";
export const TERMINAL_BROWSER_PROFILE_IDENTIFIER_MAX_LENGTH = 512;

export type TerminalBrowserRoute =
  | { kind: "unassigned" }
  | { kind: "dev-server"; port: number };

export interface TerminalBrowserWorktreePreference {
  preferredProfileId: TerminalBrowserProfileId | null;
  devServerPort: number | null;
}

export interface TerminalBrowserProfilePreferences {
  version: 1;
  defaultProfileId: TerminalBrowserProfileId;
  businessOrigin: string | null;
  worktrees: Record<string, TerminalBrowserWorktreePreference>;
}

export type TerminalBrowserProfilePreferenceUpdate =
  | {
      scope: "global";
      defaultProfileId?: TerminalBrowserProfileId;
      businessOrigin?: string | null;
    }
  | {
      scope: "worktree";
      projectId: string;
      preferredProfileId?: TerminalBrowserProfileId | null;
      devServerPort?: number | null;
    };

export interface ResolveTerminalBrowserProfileRequest {
  projectId: string | null;
  explicitProfileId: TerminalBrowserProfileId | null;
  browserGroupId: string | null;
}

export type TerminalBrowserProfileResolutionSource =
  | "explicit"
  | "worktree"
  | "global-default";

export type TerminalBrowserWhistleStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "failed";

export type TerminalBrowserProfileProxyMode = "whistle" | "direct";

export interface TerminalBrowserErrorPayload {
  code: TerminalBrowserErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export interface TerminalBrowserWhistleState {
  profileId: TerminalBrowserProfileId;
  status: TerminalBrowserWhistleStatus;
  host: "127.0.0.1";
  port: number;
  storage: string;
  pid: number | null;
  error: TerminalBrowserErrorPayload | null;
}

export interface TerminalBrowserProfileRuntimeState {
  profileId: TerminalBrowserProfileId;
  proxyMode: TerminalBrowserProfileProxyMode;
  route: TerminalBrowserRoute;
  whistle: TerminalBrowserWhistleState;
  visibleViewCount: number;
  cdpConnectionCount: number;
}

export interface ResolvedTerminalBrowserProfile {
  profileId: TerminalBrowserProfileId;
  source: TerminalBrowserProfileResolutionSource;
  projectId: string | null;
  route: TerminalBrowserRoute;
  cdpEndpoint: string;
  whistle: TerminalBrowserWhistleState;
}

export type TerminalBrowserProfileChangedEvent =
  | {
      kind: "preferences";
      preferences: TerminalBrowserProfilePreferences;
    }
  | {
      kind: "runtime";
      runtime: TerminalBrowserProfileRuntimeState;
    };

export type TerminalBrowserErrorCode =
  | "INVALID_BROWSER_PROFILE"
  | "INVALID_DEV_SERVER_PORT"
  | "INVALID_BUSINESS_ORIGIN"
  | "INVALID_PROJECT_ID"
  | "INVALID_BROWSER_GROUP_ID"
  | "BROWSER_PROFILE_ROUTE_CONFLICT"
  | "WHISTLE_PORT_IN_USE"
  | "WHISTLE_START_FAILED"
  | "WHISTLE_VALUE_UPDATE_FAILED"
  | "WHISTLE_CA_UNAVAILABLE";

export function isTerminalBrowserProfileId(
  value: unknown,
): value is TerminalBrowserProfileId {
  return TERMINAL_BROWSER_PROFILE_IDS.includes(
    value as TerminalBrowserProfileId,
  );
}

export function getTerminalBrowserProfileConfig(
  profileId: TerminalBrowserProfileId,
) {
  return TERMINAL_BROWSER_PROFILE_CONFIGS[profileId];
}

export function createDefaultTerminalBrowserProfilePreferences(): TerminalBrowserProfilePreferences {
  return {
    version: 1,
    defaultProfileId: TERMINAL_BROWSER_DEFAULT_PROFILE_ID,
    businessOrigin: null,
    worktrees: {},
  };
}
