import {
  isTerminalBrowserProfileId,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfileRuntimeState,
} from "../browser/profile";

export interface TunnelForwardConfig {
  id: string;
  name: string;
  port: number;
  path: string;
  enabled: boolean;
}
export interface TunnelHostConfig {
  id: string;
  name: string;
  sshTarget: string;
  autoConnect: boolean;
  forwards: TunnelForwardConfig[];
  browser: {
    enabled: boolean;
    backendPort: number;
    profileId: TerminalBrowserProfileId;
    approvedBrowserGroupId: string | null;
  };
}
export interface TunnelBackendEndpoint {
  id: string;
  hostId: string;
  remotePort: number;
}
export interface TunnelConfig {
  schemaVersion: 1;
  revision: number;
  desktopId: string;
  hosts: TunnelHostConfig[];
  backendEndpoints: TunnelBackendEndpoint[];
  completedImports: string[];
}
export interface TunnelConfigUpdate {
  expectedRevision: number;
  hosts: TunnelHostConfig[];
  backendEndpoints: TunnelBackendEndpoint[];
}
export interface TunnelState {
  state:
    | "disabled"
    | "waiting"
    | "starting"
    | "ready"
    | "needs_auth"
    | "failed";
  error: { code: string; message: string } | null;
}
export interface TunnelHostRuntime {
  hostId: string;
  generation: number;
  state: "disconnected" | "connecting" | "ready" | "reconnecting" | "failed";
  error: TunnelState["error"];
  forwards: Record<string, TunnelState>;
  browser: TunnelState;
  installationId: string | null;
  bindingId: string | null;
  endpoints: Record<string, string>;
}
export interface DesktopStateOwner {
  desktopId: string;
  channel: "stable" | "beta";
  devSessionId: string | null;
}
export interface TunnelSnapshot {
  schemaVersion: 1;
  config: TunnelConfig;
  owner: DesktopStateOwner;
  executorInstanceId: string;
  executor: "online" | "offline";
  observedAt: number;
  appliedRevision: number;
  hosts: TunnelHostRuntime[];
}
export interface DesktopProxySummary extends TerminalBrowserProfileRuntimeState {
  hasRules: boolean | null;
  rulesObservedAt: number | null;
}
export interface DesktopNetworkSnapshot {
  tunnels: TunnelSnapshot;
  proxyProfiles: DesktopProxySummary[];
}
export interface TunnelLogin {
  hostId: string;
  username: string;
  password: string;
}
export interface TunnelImport {
  backup: Record<string, string>;
  migrationId: string;
  expectedRevision: number;
  hosts: TunnelHostConfig[];
  backendEndpoints: TunnelBackendEndpoint[];
}
export const isTunnelId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const port = (v: unknown): v is number =>
  Number.isInteger(v) && Number(v) > 0 && Number(v) <= 65535;
const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 120;
export function validateTunnelUpdate(value: unknown): TunnelConfigUpdate {
  if (!value || typeof value !== "object")
    throw new Error("INVALID_TUNNEL_CONFIG");
  const v = value as TunnelConfigUpdate;
  if (
    !Number.isInteger(v.expectedRevision) ||
    v.expectedRevision < 0 ||
    !Array.isArray(v.hosts) ||
    v.hosts.length > 64 ||
    !Array.isArray(v.backendEndpoints) ||
    v.backendEndpoints.length > 128
  )
    throw new Error("INVALID_TUNNEL_CONFIG");
  const hosts = v.hosts.map((h) => {
    if (
      !h ||
      !isTunnelId(h.id) ||
      !text(h.name) ||
      typeof h.sshTarget !== "string" ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,254}$/.test(h.sshTarget) ||
      typeof h.autoConnect !== "boolean" ||
      !Array.isArray(h.forwards) ||
      h.forwards.length > 64
    )
      throw new Error("INVALID_TUNNEL_HOST");
    const forwards = h.forwards.map((f) => {
      if (
        !f ||
        !isTunnelId(f.id) ||
        !text(f.name) ||
        !port(f.port) ||
        typeof f.enabled !== "boolean" ||
        typeof f.path !== "string" ||
        f.path.length > 2048 ||
        !f.path.startsWith("/") ||
        f.path.startsWith("//") ||
        f.path.includes("\\")
      )
        throw new Error("INVALID_TUNNEL_FORWARD");
      return {
        id: f.id,
        name: f.name.trim(),
        port: f.port,
        enabled: f.enabled,
        path: f.path,
      };
    });
    if (
      new Set(forwards.map((f) => f.id)).size !== forwards.length ||
      new Set(forwards.map((f) => f.port)).size !== forwards.length
    )
      throw new Error("DUPLICATE_TUNNEL_PORT");
    const b = h.browser;
    if (
      !b ||
      typeof b.enabled !== "boolean" ||
      !port(b.backendPort) ||
      !isTerminalBrowserProfileId(b.profileId) ||
      !(
        b.approvedBrowserGroupId === null ||
        (typeof b.approvedBrowserGroupId === "string" &&
          b.approvedBrowserGroupId.length > 0 &&
          b.approvedBrowserGroupId.length <= 512)
      )
    )
      throw new Error("INVALID_BROWSER_TUNNEL");
    return {
      id: h.id,
      name: h.name.trim(),
      sshTarget: h.sshTarget,
      autoConnect: h.autoConnect,
      forwards,
      browser: {
        enabled: b.enabled,
        backendPort: b.backendPort,
        profileId: b.profileId,
        approvedBrowserGroupId: b.approvedBrowserGroupId,
      },
    };
  });
  if (new Set(hosts.map((h) => h.id)).size !== hosts.length)
    throw new Error("DUPLICATE_TUNNEL_HOST");
  const backendEndpoints = v.backendEndpoints.map((e) => {
    if (
      !e ||
      !isTunnelId(e.id) ||
      !hosts.some((h) => h.id === e.hostId) ||
      !port(e.remotePort)
    )
      throw new Error("INVALID_BACKEND_ENDPOINT");
    return { id: e.id, hostId: e.hostId, remotePort: e.remotePort };
  });
  if (
    new Set(backendEndpoints.map((e) => e.id)).size !== backendEndpoints.length
  )
    throw new Error("DUPLICATE_BACKEND_ENDPOINT");
  return { expectedRevision: v.expectedRevision, hosts, backendEndpoints };
}
