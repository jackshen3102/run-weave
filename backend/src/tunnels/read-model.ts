import { configuration, assertOwnedPath } from "@runweave/config-node";
import { readConfigurationPath } from "@runweave/shared/configuration";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import {
  isTunnelId,
  validateTunnelUpdate,
  type DesktopNetworkSnapshot,
  type TunnelConfig,
  type TunnelSnapshot,
} from "@runweave/shared/tunnels";

export class DesktopStateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function readJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new DesktopStateError("DESKTOP_STATE_INVALID");
    return JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}
export function readDesktopNetwork(): DesktopNetworkSnapshot {
  const root = process.env.RUNWEAVE_DESKTOP_STATE_DIR?.trim();
  if (!root || !path.isAbsolute(root))
    throw new DesktopStateError("DESKTOP_STATE_UNAVAILABLE");
  const runtime = configuration();
  assertOwnedPath(runtime.context, root);
  try {
    const saved = runtime.store.read();
    if (saved.issues["desktop.tunnels"]?.length) throw new DesktopStateError("DESKTOP_STATE_INVALID");
    const value = readConfigurationPath(saved.value, "desktop.tunnels") as unknown as Omit<TunnelConfig, "schemaVersion">;
    const raw: TunnelConfig = { ...value, schemaVersion: 1 };
    const clean = validateTunnelUpdate({
      ...raw,
      expectedRevision: raw.revision,
    });
    if (raw.schemaVersion !== 1 || !isTunnelId(raw.desktopId))
      throw new DesktopStateError("DESKTOP_STATE_INVALID");
    const network = readJson(
      path.join(root, "desktop-network.json"),
    ) as DesktopNetworkSnapshot;
    const snapshot = network.tunnels;
    const expectedSession = runtime.context.kind === "dev" ? runtime.context.instanceId : null;
    if (
      snapshot?.schemaVersion !== 1 ||
      snapshot.owner?.desktopId !== raw.desktopId ||
      snapshot.owner.devSessionId !== expectedSession ||
      snapshot.owner.channel !==
        (process.env.RUNWEAVE_DESKTOP_CHANNEL || "stable") ||
      !Number.isFinite(snapshot.observedAt) ||
      !Array.isArray(snapshot.hosts) ||
      !Array.isArray(network.proxyProfiles)
    )
      throw new DesktopStateError("DESKTOP_STATE_OWNER_MISMATCH");
    const stale =
      snapshot.executor !== "online" ||
      Date.now() - snapshot.observedAt > 15000 ||
      snapshot.observedAt > Date.now() + 5000;
    const tunnels: TunnelSnapshot = {
      ...snapshot,
      config: {
        schemaVersion: 1,
        revision: raw.revision,
        desktopId: raw.desktopId,
        hosts: clean.hosts,
        backendEndpoints: clean.backendEndpoints,
        completedImports: [],
      },
      executor: stale ? "offline" : "online",
      hosts: snapshot.hosts.map((h) =>
        stale
          ? {
              ...h,
              state: "disconnected",
              endpoints: {},
              bindingId: null,
              error: {
                code: "EXECUTOR_OFFLINE",
                message: "桌面执行器离线，配置已保留",
              },
              forwards: Object.fromEntries(
                Object.keys(h.forwards).map((id) => [
                  id,
                  { state: "waiting", error: null },
                ]),
              ),
              browser: { state: "waiting", error: null },
            }
          : h,
      ),
    };
    return {
      tunnels,
      proxyProfiles: network.proxyProfiles.map((profile) => ({
        ...profile,
        applyError: profile.applyError
          ? {
              code: profile.applyError.code,
              message: profile.applyError.message,
              details: {},
            }
          : null,
        visibleViewCount: stale ? 0 : profile.visibleViewCount,
        cdpConnectionCount: stale ? 0 : profile.cdpConnectionCount,
        whistle: {
          ...profile.whistle,
          pid: null,
          status: stale ? "stopped" : profile.whistle.status,
          error: profile.whistle.error
            ? {
                code: profile.whistle.error.code,
                message: profile.whistle.error.message,
                details: {},
              }
            : null,
        },
      })),
    };
  } catch (error) {
    if (error instanceof DesktopStateError) throw error;
    throw new DesktopStateError("DESKTOP_STATE_UNAVAILABLE");
  }
}
