import { ipcMain } from "electron";
import type { TerminalBrowserCdpProxyInfo } from "@runweave/shared/terminal-browser-cdp-proxy";
import {
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByTargetId,
} from "./terminal-browser-view.js";
import { desktopRuntime } from "./desktop-runtime-state.js";
import { getTerminalBrowserProfilePreferences } from "./terminal-browser-profile-preferences.js";

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
      const profileId =
        match?.profileId ??
        getTerminalBrowserProfilePreferences().defaultProfileId;

      if (!proxy) {
        return {
          available: false,
          endpoint: null,
          webSocketEndpoint: null,
          port: null,
          host: "127.0.0.1",
          tabId,
          profileId,
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

      const params = new URLSearchParams({ profileId });
      if (match?.browserGroupId) {
        params.set("groupId", match.browserGroupId);
      }
      const webSocketEndpoint = [
        `ws://${proxy.host}:${proxy.port}`,
        "/devtools/browser/runweave-terminal-browser",
        `?${params}`,
      ].join("");

      return {
        available: true,
        endpoint: proxy.endpoint,
        webSocketEndpoint,
        port: proxy.port,
        host: "127.0.0.1",
        tabId,
        profileId,
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
