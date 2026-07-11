import { ipcMain } from "electron";
import type { TerminalBrowserCdpProxyInfo } from "@runweave/shared/terminal-browser-cdp-proxy";
import {
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByTargetId,
} from "./terminal-browser-view.js";
import { desktopRuntime } from "./desktop-runtime-state.js";

export function registerCdpProxyHandlers(): void {
  ipcMain.handle(
    "terminal-browser:get-cdp-proxy-info",
    (_event, tabId: string): TerminalBrowserCdpProxyInfo => {
      const proxy = desktopRuntime.cdpProxy;
      const targets = getTerminalBrowserCdpTargets();
      const match = targets.find((t) => t.key.endsWith(`:${tabId}`));
      const found = match
        ? getTerminalBrowserEntryByTargetId(match.targetId)
        : null;

      if (!proxy) {
        return {
          available: false,
          endpoint: null,
          webSocketEndpoint: null,
          port: null,
          host: "127.0.0.1",
          tabId,
          targetId: null,
          browserGroupId: null,
          url: "",
          title: "",
          attached: false,
          devtoolsOpen: false,
          env: null,
          error: "CDP proxy is not running",
        };
      }

      const webSocketEndpoint = match?.browserGroupId
        ? [
            `ws://${proxy.host}:${proxy.port}`,
            "/devtools/browser/runweave-terminal-browser",
            `?groupId=${encodeURIComponent(match.browserGroupId)}`,
          ].join("")
        : null;

      return {
        available: true,
        endpoint: proxy.endpoint,
        webSocketEndpoint,
        port: proxy.port,
        host: "127.0.0.1",
        tabId,
        targetId: match?.targetId ?? null,
        browserGroupId: match?.browserGroupId ?? null,
        url: match?.url ?? "",
        title: match?.title ?? "",
        attached: found?.entry.cdpProxyAttached ?? false,
        devtoolsOpen: found?.entry.devtoolsOpen ?? false,
        env: {
          PLAYWRIGHT_MCP_CDP_ENDPOINT: webSocketEndpoint ?? proxy.endpoint,
        },
      };
    },
  );
}
