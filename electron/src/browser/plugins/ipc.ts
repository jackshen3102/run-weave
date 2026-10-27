import { ipcMain } from "electron";
import { isTerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import type { BrowserPluginCommand } from "@runweave/shared/browser-plugins";
import { trustedBrowserWindow } from "../security/sender.js";
import { getBrowserPlugins, runBrowserPluginCommand } from "./host.js";
export function registerBrowserPluginHandlers() {
  ipcMain.handle("terminal-browser:plugins-list", (event, profile) => {
    if (!trustedBrowserWindow(event) || !isTerminalBrowserProfileId(profile))
      throw Error("INVALID_BROWSER_PLUGIN_REQUEST");
    return getBrowserPlugins(profile);
  });
  ipcMain.handle(
    "terminal-browser:plugin-command",
    async (event, request: BrowserPluginCommand) => {
      const window = trustedBrowserWindow(event);
      if (
        !window ||
        !request ||
        !isTerminalBrowserProfileId(request.profileId) ||
        typeof request.pluginId !== "string" ||
        request.pluginId.length > 100 ||
        typeof request.commandId !== "string" ||
        request.commandId.length > 128
      )
        throw Error("INVALID_BROWSER_PLUGIN_REQUEST");
      await runBrowserPluginCommand(
        { window, profileId: request.profileId },
        request,
      );
      return getBrowserPlugins(request.profileId);
    },
  );
}
