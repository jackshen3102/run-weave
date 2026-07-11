import {
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserHeaderState,
} from "@runweave/shared/terminal-browser-headers";
import type { TerminalBrowserProxyState } from "@runweave/shared/terminal-browser-proxy";
import {
  getTerminalBrowserSession,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";

const TERMINAL_BROWSER_PROXY_HOST = "127.0.0.1";
const TERMINAL_BROWSER_PROXY_PORT = 8899;
const TERMINAL_BROWSER_PROXY_RULES = `http=${TERMINAL_BROWSER_PROXY_HOST}:${TERMINAL_BROWSER_PROXY_PORT};https=${TERMINAL_BROWSER_PROXY_HOST}:${TERMINAL_BROWSER_PROXY_PORT}`;
const TERMINAL_BROWSER_PROXY_BYPASS_RULES = "<local>";

let terminalBrowserProxyEnabled = false;
let terminalBrowserHeaderRules: TerminalBrowserHeaderRule[] = [];
let terminalBrowserHeaderDispatcherRegistered = false;

export function getTerminalBrowserProxyState(): TerminalBrowserProxyState {
  return {
    enabled: terminalBrowserProxyEnabled,
    proxyRules: TERMINAL_BROWSER_PROXY_RULES,
    proxyBypassRules: TERMINAL_BROWSER_PROXY_BYPASS_RULES,
  };
}

export function getTerminalBrowserHeaderState(): TerminalBrowserHeaderState {
  return {
    rules: terminalBrowserHeaderRules,
  };
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

export function ensureTerminalBrowserHeaderDispatcher(): void {
  if (terminalBrowserHeaderDispatcherRegistered) {
    return;
  }

  getTerminalBrowserSession().webRequest.onBeforeSendHeaders(
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
      for (const rule of terminalBrowserHeaderRules) {
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
  terminalBrowserHeaderDispatcherRegistered = true;
}

export function setTerminalBrowserHeaderRules(
  rules: unknown,
): TerminalBrowserHeaderState {
  terminalBrowserHeaderRules = normalizeTerminalBrowserHeaderRules(rules);
  ensureTerminalBrowserHeaderDispatcher();
  return getTerminalBrowserHeaderState();
}

export function reloadTerminalBrowserTabsForProxyChange(): void {
  for (const entry of terminalBrowserRuntime.entries.values()) {
    const webContents = entry.view.webContents;
    if (webContents.isDestroyed()) {
      continue;
    }
    const url = webContents.getURL();
    if (!url || url === "about:blank") {
      continue;
    }
    webContents.reload();
  }
}

export async function setTerminalBrowserProxyEnabled(
  enabled: boolean,
): Promise<TerminalBrowserProxyState> {
  const browserSession = getTerminalBrowserSession();
  if (enabled) {
    await browserSession.setProxy({
      mode: "fixed_servers",
      proxyRules: TERMINAL_BROWSER_PROXY_RULES,
      proxyBypassRules: TERMINAL_BROWSER_PROXY_BYPASS_RULES,
    });
  } else {
    await browserSession.setProxy({ mode: "direct" });
  }
  await browserSession.closeAllConnections();
  terminalBrowserProxyEnabled = enabled;
  reloadTerminalBrowserTabsForProxyChange();
  return getTerminalBrowserProxyState();
}
