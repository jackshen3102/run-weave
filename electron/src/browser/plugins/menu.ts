import {
  dialog,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import type { BrowserPluginMenuItem } from "@runweave/shared/browser-plugins";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { getBrowserPlugins, runBrowserPluginCommand } from "./host.js";
export function browserPluginMenu(
  window: BrowserWindow,
  profileId: TerminalBrowserProfileId,
): MenuItemConstructorOptions {
  function command(
    pluginId: string,
    item: BrowserPluginMenuItem,
  ): MenuItemConstructorOptions {
    return {
      label: item.label,
      enabled: item.enabled !== false,
      ...(item.checked !== undefined
        ? { type: "checkbox" as const, checked: item.checked }
        : {}),
      ...(item.children
        ? { submenu: item.children.map((child) => command(pluginId, child)) }
        : {
            click: () => {
              void runBrowserPluginCommand(
                { window, profileId },
                { profileId, pluginId, commandId: item.id },
              ).catch((e) =>
                dialog.showMessageBox(window, {
                  type: "error",
                  message: "浏览器插件操作未完成",
                  detail: String(e),
                }),
              );
            },
          }),
    };
  }
  return {
    label: "浏览器插件",
    submenu: getBrowserPlugins(profileId).map((plugin) => ({
      label: `${plugin.name} · ${plugin.summary}`,
      submenu: plugin.commands.map((item) => command(plugin.id, item)),
    })),
  };
}
