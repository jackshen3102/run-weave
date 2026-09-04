import {
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserHeaderState,
} from "@runweave/shared/terminal-browser-headers";
import {
  getTerminalBrowserProfileConfig,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfileProxyMode,
} from "@runweave/shared/terminal-browser-profile";
import { TERMINAL_BROWSER_PROXY_BYPASS_RULES } from "@runweave/shared/terminal-browser-proxy";
import { TerminalBrowserError } from "./terminal-browser-errors.js";
import {
  getTerminalBrowserSession,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";

const headerRulesByProfile = new Map<
  TerminalBrowserProfileId,
  TerminalBrowserHeaderRule[]
>();
const registeredHeaderSessions = new WeakSet<Electron.Session>();
const WORKSPACE_SERVICE_PROXY_PROBE_URL =
  "http://runweave-proxy-probe.localhost";
const EXTERNAL_PROXY_PROBE_URL = "https://example.com";

async function verifyTerminalBrowserProfileProxy(
  profileId: TerminalBrowserProfileId,
  proxyMode: TerminalBrowserProfileProxyMode,
): Promise<void> {
  const browserSession = getTerminalBrowserSession(profileId);
  const localRoute = await browserSession.resolveProxy(
    WORKSPACE_SERVICE_PROXY_PROBE_URL,
  );
  if (localRoute.trim() !== "DIRECT") {
    throw new TerminalBrowserError(
      "BROWSER_PROFILE_PROXY_CONFIGURATION_FAILED",
      "Workspace Service localhost traffic is not configured for direct access",
      { profileId, proxyMode, localRoute },
    );
  }
  let externalRoute: string | null = null;
  if (proxyMode === "whistle") {
    const whistlePort = getTerminalBrowserProfileConfig(profileId).whistlePort;
    externalRoute = await browserSession.resolveProxy(
      EXTERNAL_PROXY_PROBE_URL,
    );
    if (!externalRoute.includes(`127.0.0.1:${whistlePort}`)) {
      throw new TerminalBrowserError(
        "BROWSER_PROFILE_PROXY_CONFIGURATION_FAILED",
        "External traffic is not configured for the Profile Whistle proxy",
        { profileId, proxyMode, externalRoute, whistlePort },
      );
    }
  }
  console.info("[electron] terminal browser proxy verified", {
    profileId,
    proxyMode,
    localRoute,
    externalRoute,
  });
}

export function getTerminalBrowserHeaderState(
  profileId: TerminalBrowserProfileId,
): TerminalBrowserHeaderState {
  return { rules: headerRulesByProfile.get(profileId) ?? [] };
}

export function wildcardUrlPatternMatches(
  pattern: string,
  url: string,
): boolean {
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexPattern = `^${escapedPattern.replace(/\*/g, ".*")}$`;
  return new RegExp(regexPattern).test(url);
}

export function setRequestHeader(
  requestHeaders: Record<string, string>,
  name: string,
  value: string,
): void {
  const normalizedName = name.toLowerCase();
  for (const existingName of Object.keys(requestHeaders)) {
    if (
      existingName.toLowerCase() === normalizedName &&
      existingName !== name
    ) {
      delete requestHeaders[existingName];
    }
  }
  requestHeaders[name] = value;
}

export function ensureTerminalBrowserHeaderDispatcher(
  profileId: TerminalBrowserProfileId,
): void {
  const browserSession = getTerminalBrowserSession(profileId);
  if (registeredHeaderSessions.has(browserSession)) {
    return;
  }
  browserSession.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(details.url);
      } catch {
        callback({});
        return;
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        callback({});
        return;
      }
      let requestHeaders: Record<string, string> | null = null;
      for (const rule of headerRulesByProfile.get(profileId) ?? []) {
        if (
          !rule.enabled ||
          !wildcardUrlPatternMatches(rule.urlPattern, parsedUrl.toString())
        ) {
          continue;
        }
        requestHeaders ??= { ...details.requestHeaders };
        setRequestHeader(requestHeaders, rule.name, rule.value);
      }
      callback(requestHeaders ? { requestHeaders } : {});
    },
  );
  registeredHeaderSessions.add(browserSession);
}

export function setTerminalBrowserHeaderRules(
  profileId: TerminalBrowserProfileId,
  rules: unknown,
): TerminalBrowserHeaderState {
  const normalized = normalizeTerminalBrowserHeaderRules(rules);
  headerRulesByProfile.set(profileId, normalized);
  ensureTerminalBrowserHeaderDispatcher(profileId);
  return getTerminalBrowserHeaderState(profileId);
}

export async function configureTerminalBrowserProfileProxy(
  profileId: TerminalBrowserProfileId,
  proxyMode: TerminalBrowserProfileProxyMode,
): Promise<void> {
  const config = getTerminalBrowserProfileConfig(profileId);
  const browserSession = getTerminalBrowserSession(profileId);
  await browserSession.setProxy(
    proxyMode === "whistle"
      ? {
          mode: "fixed_servers",
          proxyRules: `127.0.0.1:${config.whistlePort}`,
          proxyBypassRules: TERMINAL_BROWSER_PROXY_BYPASS_RULES,
        }
      : { mode: "direct" },
  );
  await verifyTerminalBrowserProfileProxy(profileId, proxyMode);
}

export async function reloadTerminalBrowserProfileAfterProxyChange(
  profileId: TerminalBrowserProfileId,
): Promise<void> {
  await getTerminalBrowserSession(profileId).closeAllConnections();
  for (const entry of terminalBrowserRuntime.entries.values()) {
    if (entry.profileId !== profileId || entry.view.webContents.isDestroyed()) {
      continue;
    }
    const url = entry.view.webContents.getURL();
    if (url && url !== "about:blank") {
      entry.view.webContents.reload();
    }
  }
}

export function reloadTerminalBrowserBusinessOrigin(
  profileId: TerminalBrowserProfileId,
  businessOrigin: string | null,
): void {
  if (!businessOrigin) {
    return;
  }
  for (const entry of terminalBrowserRuntime.entries.values()) {
    if (entry.profileId !== profileId || entry.view.webContents.isDestroyed()) {
      continue;
    }
    try {
      const url = entry.view.webContents.getURL() || entry.lastKnownUrl;
      if (new URL(url).origin === businessOrigin) {
        entry.view.webContents.reloadIgnoringCache();
      }
    } catch {
      continue;
    }
  }
}
