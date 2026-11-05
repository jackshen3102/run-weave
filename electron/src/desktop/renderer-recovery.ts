import { dialog, type BrowserWindow } from "electron";
import { getIsQuitting } from "../app/state.js";
import { desktopRuntime } from "./runtime-state.js";

const CRASH_WINDOW_MS = 60_000;
const MAX_AUTOMATIC_RELOADS = 2;

/** Recover app windows only; embedded Browser tabs own their own lifecycle. */
export function watchRendererRecovery(win: BrowserWindow): void {
  let crashes: number[] = [];
  let recovering = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const available = () =>
    !getIsQuitting() && !win.isDestroyed() && !win.webContents.isDestroyed();
  const reload = () => {
    if (!available()) return;
    desktopRuntime.incidentLogger?.info("desktop.rendererRecovery.reload", {
      windowId: win.id,
      recentCrashes: crashes.length,
    });
    win.reload();
  };

  win.webContents.on("render-process-gone", (_event, details) => {
    if (
      !available() || recovering ||
      !["crashed", "oom", "abnormal-exit"].includes(details.reason)
    ) return;

    const now = Date.now();
    crashes = crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    crashes.push(now);
    desktopRuntime.incidentLogger?.warn("desktop.rendererRecovery.requested", {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
      recentCrashes: crashes.length,
      automatic: crashes.length <= MAX_AUTOMATIC_RELOADS,
    });

    if (crashes.length <= MAX_AUTOMATIC_RELOADS) {
      reloadTimer = setTimeout(reload, 0);
      return;
    }

    recovering = true;
    void dialog.showMessageBox(win, {
      type: "error",
      title: "Runweave 界面恢复失败",
      message: "界面连续崩溃，已暂停自动恢复。",
      detail: "可以重新加载界面。终端任务仍由后台服务管理。",
      buttons: ["重新加载", "暂不恢复"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0 && available()) {
        crashes = [];
        reload();
      }
    }).catch((error: unknown) => {
      desktopRuntime.incidentLogger?.error("desktop.rendererRecovery.failed", { error });
    }).finally(() => {
      recovering = false;
    });
  });
  win.once("closed", () => clearTimeout(reloadTimer));
}
