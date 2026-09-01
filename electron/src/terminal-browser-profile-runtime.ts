import { BrowserWindow } from "electron";
import {
  getTerminalBrowserProfileConfig,
  isTerminalBrowserProfileId,
  TERMINAL_BROWSER_PROFILE_IDS,
  type ResolveTerminalBrowserProfileRequest,
  type ResolvedTerminalBrowserProfile,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfileRuntimeState,
  type TerminalBrowserRoute,
} from "@runweave/shared/terminal-browser-profile";
import { desktopRuntime } from "./desktop-runtime-state.js";
import { ensureTerminalBrowserCertificateTrust } from "./terminal-browser-certificate.js";
import { TerminalBrowserError } from "./terminal-browser-errors.js";
import {
  getTerminalBrowserProfilePreferences,
  normalizeTerminalBrowserGroupId,
  normalizeTerminalBrowserProjectId,
} from "./terminal-browser-profile-preferences.js";
import { terminalBrowserRuntime } from "./terminal-browser-runtime.js";
import {
  applyTerminalBrowserProfileProxy,
  reloadTerminalBrowserBusinessOrigin,
} from "./terminal-browser-network.js";
import { setWhistleReservedValue } from "./terminal-browser-whistle-client.js";
import {
  ensureTerminalBrowserWhistle,
  getTerminalBrowserWhistleState,
  terminalBrowserWhistleEvents,
} from "./terminal-browser-whistle-runtime.js";

interface ProfileRuntimeRecord {
  route: TerminalBrowserRoute;
  mutationQueue: Promise<unknown>;
  cdpConnectionCount: number;
}

const records = new Map<TerminalBrowserProfileId, ProfileRuntimeRecord>(
  TERMINAL_BROWSER_PROFILE_IDS.map((profileId) => [
    profileId,
    {
      route: { kind: "unassigned" },
      mutationQueue: Promise.resolve(),
      cdpConnectionCount: 0,
    },
  ]),
);

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
  const record = records.get(profileId)!;
  return {
    profileId,
    route: structuredClone(record.route),
    whistle: getTerminalBrowserWhistleState(profileId),
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
  const record = records.get(profileId)!;
  record.cdpConnectionCount = Math.max(0, record.cdpConnectionCount + delta);
  notifyRuntimeChanged(profileId);
}

function buildCdpEndpoint(
  profileId: TerminalBrowserProfileId,
  browserGroupId: string | null,
): string {
  const proxy = desktopRuntime.cdpProxy;
  if (!proxy) {
    throw new Error("Terminal Browser CDP proxy is not running");
  }
  const params = new URLSearchParams({ profileId });
  if (browserGroupId) {
    params.set("groupId", browserGroupId);
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
  const browserGroupId = normalizeTerminalBrowserGroupId(
    request.browserGroupId,
  );
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
  const requestedRoute: TerminalBrowserRoute = worktree?.devServerPort
    ? { kind: "dev-server", port: worktree.devServerPort }
    : { kind: "unassigned" };
  const record = records.get(profileId)!;

  const mutation = record.mutationQueue.then(async () => {
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

    const whistle = await ensureTerminalBrowserWhistle(profileId);
    await applyTerminalBrowserProfileProxy(profileId);
    await ensureTerminalBrowserCertificateTrust(profileId);
    await setWhistleReservedValue(
      profileId,
      whistle.port,
      requestedRoute.kind === "dev-server"
        ? `127.0.0.1:${requestedRoute.port}`
        : null,
    );
    record.route = requestedRoute;
    if (routeChanges) {
      reloadTerminalBrowserBusinessOrigin(
        profileId,
        preferences.businessOrigin,
      );
    }
    notifyRuntimeChanged(profileId);
    return {
      profileId,
      source,
      projectId,
      route: structuredClone(record.route),
      cdpEndpoint: buildCdpEndpoint(profileId, browserGroupId),
      whistle: getTerminalBrowserWhistleState(profileId),
    } satisfies ResolvedTerminalBrowserProfile;
  });
  record.mutationQueue = mutation.catch(() => undefined);
  return await mutation;
}
