import {
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserHeaderState,
} from "@runweave/shared/terminal-browser-headers";
import {
  buildTerminalBrowserProxyRules,
  isValidTerminalBrowserProxyPort,
  TERMINAL_BROWSER_PROXY_DEFAULT_PORT,
  type TerminalBrowserProxyState,
} from "@runweave/shared/terminal-browser-proxy";
import {
  getTerminalBrowserSession,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";
import {
  readTerminalBrowserProxyPreferences,
  writeTerminalBrowserProxyPreferences,
} from "./terminal-browser-proxy-preferences.js";

const TERMINAL_BROWSER_PROXY_BYPASS_RULES = "<local>";

let terminalBrowserProxyEnabled = false;
let terminalBrowserProxyPort = TERMINAL_BROWSER_PROXY_DEFAULT_PORT;
let terminalBrowserHeaderRules: TerminalBrowserHeaderRule[] = [];
let terminalBrowserHeaderDispatcherRegistered = false;

// Load persisted proxy preferences into module state. When the proxy was left
// enabled, re-apply it to the browser session so the restored toggle actually
// routes traffic; otherwise the port is simply restored for the next enable.
export function loadTerminalBrowserProxyPreferences(): void {
  const preferences = readTerminalBrowserProxyPreferences();
  terminalBrowserProxyEnabled = preferences.enabled;
  terminalBrowserProxyPort = preferences.port;
  if (terminalBrowserProxyEnabled) {
    void applyTerminalBrowserSessionProxy().catch(() => {
      // Session proxy application is retried on the next explicit toggle.
    });
  }
}

function persistTerminalBrowserProxyPreferences(): void {
  writeTerminalBrowserProxyPreferences({
    enabled: terminalBrowserProxyEnabled,
    port: terminalBrowserProxyPort,
  });
}

export function getTerminalBrowserProxyState(): TerminalBrowserProxyState {
  return {
    enabled: terminalBrowserProxyEnabled,
    port: terminalBrowserProxyPort,
    proxyRules: buildTerminalBrowserProxyRules(terminalBrowserProxyPort),
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

async function applyTerminalBrowserSessionProxy(): Promise<void> {
  const browserSession = getTerminalBrowserSession();
  if (terminalBrowserProxyEnabled) {
    await browserSession.setProxy({
      mode: "fixed_servers",
      proxyRules: buildTerminalBrowserProxyRules(terminalBrowserProxyPort),
      proxyBypassRules: TERMINAL_BROWSER_PROXY_BYPASS_RULES,
    });
  } else {
    await browserSession.setProxy({ mode: "direct" });
  }
  await browserSession.closeAllConnections();
  reloadTerminalBrowserTabsForProxyChange();
}

export async function setTerminalBrowserProxyEnabled(
  enabled: boolean,
): Promise<TerminalBrowserProxyState> {
  terminalBrowserProxyEnabled = enabled;
  await applyTerminalBrowserSessionProxy();
  persistTerminalBrowserProxyPreferences();
  return getTerminalBrowserProxyState();
}

export async function setTerminalBrowserProxyPort(
  port: number,
): Promise<TerminalBrowserProxyState> {
  if (!isValidTerminalBrowserProxyPort(port)) {
    throw new Error("Invalid browser proxy port");
  }
  terminalBrowserProxyPort = port;
  // Only re-apply the session proxy when the proxy is active; when disabled the
  // new port is just persisted and takes effect on the next enable.
  if (terminalBrowserProxyEnabled) {
    await applyTerminalBrowserSessionProxy();
  }
  persistTerminalBrowserProxyPreferences();
  return getTerminalBrowserProxyState();
}
