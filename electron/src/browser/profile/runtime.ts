import { BrowserWindow } from "electron";
import {
  assertAutomationProfileAvailable,
  deriveAutomationBrowserGroupId,
  mintAutomationAttributionToken,
  normalizeAutomationTerminalSessionId,
} from "../automation/attribution.js";
import {
  getTerminalBrowserProfileConfig,
  isTerminalBrowserProfileId,
  TERMINAL_BROWSER_PROFILE_IDS,
  type ResolveTerminalBrowserProfileRequest,
  type ResolvedTerminalBrowserProfile,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfileProxyMode,
  type TerminalBrowserProfileRuntimeState,
  type TerminalBrowserRoute,
  type TerminalBrowserProfilePreferenceUpdate,
  type TerminalBrowserErrorPayload,
} from "@runweave/shared/terminal-browser-profile";
import { desktopRuntime } from "../../desktop/runtime-state.js";
import { isManagedDevSession } from "../../desktop/config.js";
import { ensureTerminalBrowserCertificateTrust } from "../security/certificate.js";
import {
  TerminalBrowserError,
  toTerminalBrowserErrorPayload,
} from "../errors.js";
import {
  getTerminalBrowserProfilePreferences,
  normalizeTerminalBrowserGroupId,
  normalizeTerminalBrowserProjectId,
  saveTerminalBrowserProfileProxyMode,
  updateTerminalBrowserProfilePreferences,
} from "./preferences.js";
import { terminalBrowserRuntime } from "../runtime.js";
import {
  configureTerminalBrowserProfileProxy,
  reloadTerminalBrowserBusinessOrigin,
  reloadTerminalBrowserProfileAfterProxyChange,
} from "../security/network.js";
import { setWhistleReservedValue } from "../whistle/client.js";
import {
  ensureTerminalBrowserWhistle,
  getTerminalBrowserWhistleState,
  terminalBrowserWhistleEvents,
} from "../whistle/runtime.js";

interface ProfileRuntimeRecord {
  proxyMode: TerminalBrowserProfileProxyMode;
  route: TerminalBrowserRoute;
  mutationQueue: Promise<unknown>;
  applyError: TerminalBrowserErrorPayload | null;
  cdpConnectionCount: number;
}

const records = new Map<TerminalBrowserProfileId, ProfileRuntimeRecord>();

function getProfileRecord(
  profileId: TerminalBrowserProfileId,
): ProfileRuntimeRecord {
  let record = records.get(profileId);
  if (!record) {
    // Read lazily, after the host has selected its userData directory.
    record = {
      proxyMode:
        getTerminalBrowserProfilePreferences().proxyModes?.[profileId] ??
        (isManagedDevSession ? "direct" : "whistle"),
      route: desiredRoute(profileId),
      applyError: null,
      mutationQueue: Promise.resolve(),
      cdpConnectionCount: 0,
    };
    records.set(profileId, record);
  }
  return record;
}

function routesEqual(left: TerminalBrowserRoute, right: TerminalBrowserRoute) {
  return (
    left.kind === right.kind &&
    (left.kind === "unassigned" ||
      (right.kind === "dev-server" && left.port === right.port))
  );
}

function getVisibleViewCount(
  profileId: TerminalBrowserProfileId,
  excludedWindowId?: number,
): number {
  let count = 0;
  for (const entry of terminalBrowserRuntime.entries.values()) {
    if (
      entry.profileId === profileId &&
      entry.windowId !== excludedWindowId &&
      entry.visible
    ) {
      count += 1;
    }
  }
  return count;
}

export function getTerminalBrowserProfileRuntimeState(
  profileId: TerminalBrowserProfileId,
): TerminalBrowserProfileRuntimeState {
  const record = getProfileRecord(profileId);
  return {
    profileId,
    proxyMode: record.proxyMode,
    route: structuredClone(record.route),
    whistle: getTerminalBrowserWhistleState(profileId),
    applyError: record.applyError,
    visibleViewCount: getVisibleViewCount(profileId),
    cdpConnectionCount: record.cdpConnectionCount,
  };
}

export function getTerminalBrowserProfileRuntimeStates(): TerminalBrowserProfileRuntimeState[] {
  return TERMINAL_BROWSER_PROFILE_IDS.map(
    getTerminalBrowserProfileRuntimeState,
  );
}

function notifyRuntimeChanged(profileId: TerminalBrowserProfileId): void {
  const runtime = getTerminalBrowserProfileRuntimeState(profileId);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("terminal-browser:profile-changed", {
        kind: "runtime",
        runtime,
      });
    }
  }
}

terminalBrowserWhistleEvents.on("changed", ({ profileId }) => {
  if (isTerminalBrowserProfileId(profileId)) {
    notifyRuntimeChanged(profileId);
  }
});

export function changeTerminalBrowserCdpConnectionCount(
  profileId: TerminalBrowserProfileId,
  delta: 1 | -1,
): void {
  const record = getProfileRecord(profileId);
  record.cdpConnectionCount = Math.max(0, record.cdpConnectionCount + delta);
  notifyRuntimeChanged(profileId);
}

function buildCdpEndpoint(
  profileId: TerminalBrowserProfileId,
  browserGroupId: string | null,
  automationToken: string | null,
): string {
  const proxy = desktopRuntime.cdpProxy;
  if (!proxy) {
    throw new Error("Terminal Browser CDP proxy is not running");
  }
  const params = new URLSearchParams({ profileId });
  if (browserGroupId) {
    params.set("groupId", browserGroupId);
  }
  if (automationToken) {
    params.set("automationToken", automationToken);
  }
  return `ws://${proxy.host}:${proxy.port}/devtools/browser/runweave-terminal-browser?${params}`;
}

export async function resolveTerminalBrowserProfile(
  request: ResolveTerminalBrowserProfileRequest,
  options: { excludedWindowId?: number } = {},
): Promise<ResolvedTerminalBrowserProfile> {
  if (!request || typeof request !== "object") {
    throw new TerminalBrowserError(
      "INVALID_BROWSER_PROFILE",
      "Invalid Terminal Browser Profile resolution request",
    );
  }
  const projectId =
    request.projectId === null
      ? null
      : normalizeTerminalBrowserProjectId(request.projectId);
  const terminalSessionId = normalizeAutomationTerminalSessionId(
    request.terminalSessionId,
  );
  const requestedBrowserGroupId = normalizeTerminalBrowserGroupId(
    request.browserGroupId,
  );
  const browserGroupId =
    requestedBrowserGroupId ??
    (terminalSessionId
      ? deriveAutomationBrowserGroupId(terminalSessionId)
      : null);
  if (
    request.explicitProfileId !== null &&
    !isTerminalBrowserProfileId(request.explicitProfileId)
  ) {
    throw new TerminalBrowserError(
      "INVALID_BROWSER_PROFILE",
      "Unknown Terminal Browser Profile",
      { profileId: request.explicitProfileId },
    );
  }
  const preferences = getTerminalBrowserProfilePreferences();
  const worktree = projectId ? preferences.worktrees[projectId] : undefined;
  const profileId =
    request.explicitProfileId ??
    worktree?.preferredProfileId ??
    preferences.defaultProfileId;
  const source = request.explicitProfileId
    ? "explicit"
    : worktree?.preferredProfileId
      ? "worktree"
      : "global-default";
  if (terminalSessionId) {
    assertAutomationProfileAvailable(terminalSessionId, profileId);
  }
  const record = getProfileRecord(profileId);

  const mutation = record.mutationQueue.then(async () => {
    const requestedRoute = desiredRoute(profileId);
    assertPortMigrationResolved(profileId);
    const routeChanges = !routesEqual(record.route, requestedRoute);
    const visibleViewCount = getVisibleViewCount(
      profileId,
      options.excludedWindowId,
    );
    if (
      routeChanges &&
      (visibleViewCount > 0 || record.cdpConnectionCount > 0)
    ) {
      throw new TerminalBrowserError(
        "BROWSER_PROFILE_ROUTE_CONFLICT",
        `${getTerminalBrowserProfileConfig(profileId).label} is currently in use`,
        {
          profileId,
          currentRoute: record.route,
          requestedRoute,
          visibleViewCount,
          cdpConnectionCount: record.cdpConnectionCount,
        },
      );
    }

    let whistle = getTerminalBrowserWhistleState(profileId);
    if (record.proxyMode === "whistle") {
      whistle = await ensureTerminalBrowserWhistle(profileId);
      await configureTerminalBrowserProfileProxy(profileId, "whistle");
      await ensureTerminalBrowserCertificateTrust(profileId);
      await setWhistleReservedValue(
        profileId,
        whistle.port,
        requestedRoute.kind === "dev-server"
          ? `127.0.0.1:${requestedRoute.port}`
          : null,
      );
    } else {
      await configureTerminalBrowserProfileProxy(profileId, "direct");
    }
    record.route = requestedRoute;
    if (routeChanges) {
      reloadTerminalBrowserBusinessOrigin(
        profileId,
        preferences.businessOrigin,
      );
    }
    record.applyError = null;
    notifyRuntimeChanged(profileId);
    const automationToken =
      terminalSessionId && browserGroupId
        ? mintAutomationAttributionToken({
            terminalSessionId,
            profileId,
            browserGroupId,
          })
        : null;
    return {
      profileId,
      source,
      projectId,
      route: structuredClone(record.route),
      cdpEndpoint: buildCdpEndpoint(profileId, browserGroupId, automationToken),
      browserGroupId,
      automationAttribution: terminalSessionId ? "terminal" : "unattributed",
      whistle: getTerminalBrowserWhistleState(profileId),
    } satisfies ResolvedTerminalBrowserProfile;
  });
  record.mutationQueue = mutation.catch((error) => {
    record.applyError = toTerminalBrowserErrorPayload(
      error,
      "BROWSER_PROFILE_PROXY_CONFIGURATION_FAILED",
    );
    notifyRuntimeChanged(profileId);
  });
  return await mutation;
}

export async function setTerminalBrowserProfileProxyMode(
  profileId: TerminalBrowserProfileId,
  proxyMode: TerminalBrowserProfileProxyMode,
): Promise<TerminalBrowserProfileRuntimeState> {
  const record = getProfileRecord(profileId);
  const mutation = record.mutationQueue.then(async () => {
    saveTerminalBrowserProfileProxyMode(profileId, proxyMode);
    record.proxyMode = proxyMode;
    record.route = desiredRoute(profileId);
    notifyRuntimeChanged(profileId);
    if (proxyMode === "whistle") {
      assertPortMigrationResolved(profileId);
      await configureTerminalBrowserProfileProxy(profileId, "whistle");
      const whistle = await ensureTerminalBrowserWhistle(profileId);
      await ensureTerminalBrowserCertificateTrust(profileId);
      await setWhistleReservedValue(
        profileId,
        whistle.port,
        record.route.kind === "dev-server"
          ? `127.0.0.1:${record.route.port}`
          : null,
      );
    } else {
      await configureTerminalBrowserProfileProxy(profileId, "direct");
    }

    record.proxyMode = proxyMode;
    record.applyError = null;
    await reloadTerminalBrowserProfileAfterProxyChange(profileId);
    notifyRuntimeChanged(profileId);
    return getTerminalBrowserProfileRuntimeState(profileId);
  });
  record.mutationQueue = mutation.catch((error) => {
    record.applyError = toTerminalBrowserErrorPayload(
      error,
      "BROWSER_PROFILE_PROXY_CONFIGURATION_FAILED",
    );
    notifyRuntimeChanged(profileId);
  });
  return await mutation;
}

function desiredRoute(
  profileId: TerminalBrowserProfileId,
): TerminalBrowserRoute {
  const port = getTerminalBrowserProfilePreferences().profilePorts[profileId];
  return port ? { kind: "dev-server", port } : { kind: "unassigned" };
}
function assertPortMigrationResolved(
  profileId: TerminalBrowserProfileId,
): void {
  if (
    getTerminalBrowserProfilePreferences().pendingPortMigration[profileId]
      ?.length
  )
    throw new TerminalBrowserError(
      "PROFILE_PORT_MIGRATION_REQUIRED",
      "请在 Browser 设置中确认旧开发端口，原代理规则已保留",
      { profileId },
    );
}
export async function updateProfilePreferencesAndApply(
  update: TerminalBrowserProfilePreferenceUpdate,
  windowId?: number,
) {
  if (update?.scope !== "profile")
    return updateTerminalBrowserProfilePreferences(update);
  if (!isTerminalBrowserProfileId(update.profileId))
    throw new TerminalBrowserError(
      "INVALID_BROWSER_PROFILE",
      "Unknown Profile",
    );
  const profileId = update.profileId;
  const record = getProfileRecord(profileId);
  const mutation = record.mutationQueue.then(async () => {
    const nextPort = update.devServerPort;
    if (
      nextPort !==
        getTerminalBrowserProfilePreferences().profilePorts[profileId] &&
      (record.cdpConnectionCount > 0 ||
        getVisibleViewCount(profileId, windowId) > 0)
    )
      throw new TerminalBrowserError(
        "BROWSER_PROFILE_ROUTE_CONFLICT",
        "Browser 正在被其他窗口或 Agent 使用，请结束操作后再修改代理目标",
        { profileId },
      );
    const preferences = updateTerminalBrowserProfilePreferences(update);
    record.route = desiredRoute(profileId);
    if (record.proxyMode === "whistle") {
      const whistle = await ensureTerminalBrowserWhistle(profileId);
      await setWhistleReservedValue(
        profileId,
        whistle.port,
        record.route.kind === "dev-server"
          ? `127.0.0.1:${record.route.port}`
          : null,
      );
      await configureTerminalBrowserProfileProxy(profileId, "whistle");
      await ensureTerminalBrowserCertificateTrust(profileId);
    }
    record.applyError = null;
    notifyRuntimeChanged(profileId);
    reloadTerminalBrowserBusinessOrigin(profileId, preferences.businessOrigin);
    return preferences;
  });
  record.mutationQueue = mutation.catch((error) => {
    record.applyError = toTerminalBrowserErrorPayload(
      error,
      "BROWSER_PROFILE_PROXY_CONFIGURATION_FAILED",
    );
    notifyRuntimeChanged(profileId);
  });
  return mutation;
}
