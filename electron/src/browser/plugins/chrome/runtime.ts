import { BrowserWindow, dialog, session } from "electron";
import { readFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  TERMINAL_BROWSER_PROFILE_IDS,
  getTerminalBrowserProfileConfig,
  isTerminalBrowserProfileId,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { historyUuid } from "@runweave/shared/browser-history";
import {
  desktopStateRoot,
  writePrivateJson,
} from "../../../desktop/local-state.js";
import {
  readChromeManifest,
  copyChromePackage,
  chromePermissionSummary,
} from "./package.js";

interface Installation {
  id: string;
  profileId: TerminalBrowserProfileId;
  extensionId: string;
  name: string;
  version: string;
  enabled: boolean;
  hasPopup?: boolean;
  key?: string;
}
let catalog: Installation[] | undefined;
let chain: Promise<unknown> = Promise.resolve();
const faults = new Map<string, string>();
const popups = new Map<string, Set<BrowserWindow>>();
function closePopups(id: string) {
  for (const window of popups.get(id) ?? [])
    if (!window.isDestroyed()) window.close();
  popups.delete(id);
}
const root = () => path.join(desktopStateRoot(), "browser-extensions");
const file = () => path.join(desktopStateRoot(), "browser-extensions.v1.json");
const directory = (item: Installation) => path.join(root(), item.id);
const target = (profile: TerminalBrowserProfileId) =>
  session.fromPartition(getTerminalBrowserProfileConfig(profile).partition)
    .extensions;
export function chromeInstallations(profile: TerminalBrowserProfileId) {
  if (!catalog) {
    try {
      const saved = JSON.parse(readFileSync(file(), "utf8"));
      if (
        saved.schemaVersion !== 1 ||
        !Array.isArray(saved.installations) ||
        saved.installations.length > 100 ||
        saved.installations.some(
          (i: Installation) =>
            !i ||
            !historyUuid(i.id) ||
            !isTerminalBrowserProfileId(i.profileId) ||
            !/^[a-p]{32}$/.test(i.extensionId) ||
            typeof i.name !== "string" ||
            typeof i.version !== "string" ||
            typeof i.enabled !== "boolean",
        )
      )
        throw Error("扩展登记文件损坏，原文件已保留");
      catalog = saved.installations;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      catalog = [];
    }
  }
  return catalog!.filter((i) => i.profileId === profile);
}
function save(items: Installation[]) {
  writePrivateJson(file(), { schemaVersion: 1, installations: items });
  catalog = items;
}
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task);
  chain = next.catch(() => undefined);
  return next;
}
async function load(item: Installation) {
  try {
    await readChromeManifest(directory(item));
    const extension = await target(item.profileId).loadExtension(
      directory(item),
      { allowFileAccess: false },
    );
    if (extension.id !== item.extensionId) {
      target(item.profileId).removeExtension(extension.id);
      throw Error("扩展身份已变化，请重新安装");
    }
    faults.delete(item.id);
  } catch (e) {
    faults.set(item.id, String(e));
  }
}
export async function startChromeExtensions() {
  for (const profile of TERMINAL_BROWSER_PROFILE_IDS)
    for (const item of chromeInstallations(profile))
      if (item.enabled) await load(item);
}
export function chromeInstallationStatus(item: Installation) {
  const loaded = Boolean(target(item.profileId).getExtension(item.extensionId));
  return {
    loaded,
    error:
      faults.get(item.id) ?? (item.enabled && !loaded ? "扩展未加载" : null),
  };
}
export async function installChromeExtension(
  window: BrowserWindow,
  profile: TerminalBrowserProfileId,
) {
  return serial(async () => {
    chromeInstallations(profile);
    const result = await dialog.showOpenDialog(window, {
      title: `${profile} · 选择解包扩展目录`,
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return;
    const manifest = await readChromeManifest(result.filePaths[0]);
    const { permissions, warnings } = chromePermissionSummary(manifest);
    if (
      manifest.key &&
      chromeInstallations(profile).some((i) => i.key === manifest.key)
    )
      throw Error("此 Profile 已安装同一扩展，请先卸载旧版本");
    if (catalog!.length >= 100) throw Error("扩展安装数量已达到 100");
    const review = await dialog.showMessageBox(window, {
      type: "question",
      message: `加载 ${manifest.name} ${manifest.version}？`,
      detail: `目标：${profile}\n权限与匹配站点：\n${permissions.join("\n") || "无额外声明"}\n\n${warnings.join("\n")}\nElectron 仅支持部分 Chrome API。加载成功不代表功能已兼容。扩展仅用于此 Profile；不加载到临时本地预览。`,
      buttons: ["取消", "加载扩展"],
      defaultId: 0,
      cancelId: 0,
    });
    if (review.response !== 1) return;
    mkdirSync(root(), { recursive: true, mode: 0o700 });
    const id = randomUUID(),
      owned = path.join(root(), id);
    let extensionId: string | undefined;
    try {
      await copyChromePackage(result.filePaths[0], owned);
      const installedManifest = await readChromeManifest(owned);
      if (JSON.stringify(installedManifest) !== JSON.stringify(manifest))
        throw Error("安装期间 manifest 已变化，请重新选择");
      const extension = await target(profile).loadExtension(owned, {
        allowFileAccess: false,
      });
      extensionId = extension.id;
      if (
        chromeInstallations(profile).some((i) => i.extensionId === extension.id)
      )
        throw Error("扩展 ID 与已有安装冲突");
      save([
        ...catalog!,
        {
          id,
          profileId: profile,
          extensionId,
          name: manifest.name,
          version: manifest.version,
          enabled: true,
          hasPopup: Boolean(
            manifest.action?.default_popup ??
            manifest.browser_action?.default_popup,
          ),
          ...(manifest.key ? { key: manifest.key } : {}),
        },
      ]);
    } catch (e) {
      if (extensionId) {
        target(profile).removeExtension(extensionId);
        const previous = chromeInstallations(profile).find(
          (i) => i.extensionId === extensionId,
        );
        if (previous?.enabled) await load(previous);
      }
      await rm(owned, { recursive: true, force: true });
      throw e;
    }
  });
}
export async function toggleChromeExtension(
  profile: TerminalBrowserProfileId,
  id: string,
) {
  return serial(async () => {
    const item = chromeInstallations(profile).find((i) => i.id === id);
    if (!item) throw Error("扩展已不存在");
    const enabled = !item.enabled;
    if (enabled) {
      await load(item);
      if (faults.has(id)) throw Error(faults.get(id));
      try {
        save(catalog!.map((i) => (i.id === id ? { ...i, enabled: true } : i)));
      } catch (e) {
        target(profile).removeExtension(item.extensionId);
        throw e;
      }
    } else {
      save(catalog!.map((i) => (i.id === id ? { ...i, enabled: false } : i)));
      closePopups(id);
      target(profile).removeExtension(item.extensionId);
      faults.delete(id);
    }
  });
}
export async function removeChromeExtension(
  window: BrowserWindow,
  profile: TerminalBrowserProfileId,
  id: string,
) {
  return serial(async () => {
    const item = chromeInstallations(profile).find((i) => i.id === id);
    if (!item) throw Error("扩展已不存在");
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      message: `卸载 ${item.name}？`,
      detail: `仅移除此 Profile 的扩展安装与本机副本；浏览记录日志保留。`,
      buttons: ["取消", "卸载"],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response !== 1) return;
    closePopups(id);
    target(profile).removeExtension(item.extensionId);
    try {
      save(catalog!.filter((i) => i.id !== id));
    } catch (e) {
      if (item.enabled) await load(item);
      throw e;
    }
    await rm(directory(item), { recursive: true, force: true });
    faults.delete(id);
  });
}
export async function chromeExtensionDetails(
  window: BrowserWindow,
  profile: TerminalBrowserProfileId,
  id: string,
) {
  const item = chromeInstallations(profile).find((i) => i.id === id);
  if (!item) throw Error("扩展已不存在");
  const manifest = await readChromeManifest(directory(item)),
    info = chromePermissionSummary(manifest),
    state = chromeInstallationStatus(item);
  await dialog.showMessageBox(window, {
    type: state.error ? "warning" : "info",
    message: `${item.name} ${item.version}`,
    detail: `${state.error ?? (state.loaded ? "Electron 已加载；功能兼容尚未确认" : "已停用")}\nProfile：${profile}\nID：${item.extensionId}\n目录：${directory(item)}\n权限：${info.permissions.join(", ") || "无"}\n${info.warnings.join("\n")}\n临时本地预览不继承此扩展。`,
  });
}
export async function openChromeExtensionPopup(
  window: BrowserWindow,
  profile: TerminalBrowserProfileId,
  id: string,
) {
  const item = chromeInstallations(profile).find((i) => i.id === id);
  if (!item || !chromeInstallationStatus(item).loaded)
    throw Error("扩展未加载");
  const manifest = await readChromeManifest(directory(item)),
    popup =
      manifest.action?.default_popup ?? manifest.browser_action?.default_popup;
  if (typeof popup !== "string" || !popup)
    throw Error("扩展没有声明 popup 页面");
  const origin = `chrome-extension://${item.extensionId}`,
    url = new URL(popup, origin + "/");
  if (
    url.protocol !== "chrome-extension:" ||
    url.hostname !== item.extensionId ||
    !url.pathname ||
    popup.includes("..")
  )
    throw Error("扩展 popup 路径无效");
  const child = new BrowserWindow({
    parent: window,
    width: 440,
    height: 600,
    title: item.name,
    webPreferences: {
      partition: getTerminalBrowserProfileConfig(profile).partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const windows = popups.get(id) ?? new Set<BrowserWindow>();
  windows.add(child);
  popups.set(id, windows);
  child.once("closed", () => {
    windows.delete(child);
    if (!windows.size) popups.delete(id);
  });
  child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  child.webContents.on("will-navigate", (event, next) => {
    if (!next.startsWith(origin + "/")) event.preventDefault();
  });
  try {
    await child.loadURL(url.toString());
  } catch (e) {
    child.close();
    throw e;
  }
}
