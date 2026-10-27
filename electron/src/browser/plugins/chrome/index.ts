import type { BrowserPlugin } from "../contract.js";
import {
  chromeInstallations,
  chromeInstallationStatus,
  startChromeExtensions,
  installChromeExtension,
  toggleChromeExtension,
  removeChromeExtension,
  chromeExtensionDetails,
  openChromeExtensionPopup,
} from "./runtime.js";

export const chromeExtensionsPlugin: BrowserPlugin = {
  id: "chrome-extensions",
  name: "Chrome 扩展",
  kind: "chrome",
  start: startChromeExtensions,
  status(profile) {
    const items = chromeInstallations(profile),
      states = items.map(chromeInstallationStatus);
    const errors = states.filter((s) => s.error),
      loaded = states.filter((s) => s.loaded).length;
    return {
      enabled: true,
      state: errors.length ? "error" : loaded ? "loaded-unverified" : "ready",
      summary: `${items.length} 个安装，${loaded} 个加载${errors.length ? `，${errors.length} 个异常` : ""}`,
      detail:
        "仅支持解包扩展。Electron 已加载不代表功能兼容；临时本地预览不继承扩展。",
    };
  },
  commands(profile) {
    return [
      { id: "install", label: "安装解包扩展…" },
      ...chromeInstallations(profile).map((item) => ({
        id: `item:${item.id}`,
        label: `${item.name} · ${chromeInstallationStatus(item).error ? "异常" : item.enabled ? "已加载，兼容未确认" : "已停用"}`,
        children: [
          { id: `toggle:${item.id}`, label: "启用", checked: item.enabled },
          {
            id: `popup:${item.id}`,
            label: "打开扩展页面",
            enabled:
              item.hasPopup === true && chromeInstallationStatus(item).loaded,
          },
          { id: `details:${item.id}`, label: "权限与兼容状态" },
          { id: `remove:${item.id}`, label: "卸载…" },
        ],
      })),
    ];
  },
  async run({ window, profileId }, command) {
    if (command === "install") await installChromeExtension(window, profileId);
    else {
      const [operation, id] = command.split(":");
      if (operation === "toggle") await toggleChromeExtension(profileId, id!);
      else if (operation === "remove")
        await removeChromeExtension(window, profileId, id!);
      else if (operation === "details")
        await chromeExtensionDetails(window, profileId, id!);
      else if (operation === "popup")
        await openChromeExtensionPopup(window, profileId, id!);
    }
  },
};
