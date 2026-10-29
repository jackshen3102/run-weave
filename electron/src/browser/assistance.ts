import { BrowserWindow, ipcMain } from "electron";
import type { BrowserAssistanceTarget } from "@runweave/shared/terminal-browser-assistance";
import { getTerminalBrowserCdpTargets } from "./proxy/api.js";
import { terminalBrowserRuntime } from "./runtime.js";

export function registerBrowserAssistanceTargetHandler(): void {
  ipcMain.handle("terminal-browser:resolve-assistance-target", (event, binding: BrowserAssistanceTarget, revealPopup?: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const target = win && binding && getTerminalBrowserCdpTargets().find((candidate) =>
      candidate.windowId === win.id && candidate.targetId === binding.targetId &&
      candidate.profileId === binding.profileId && candidate.browserGroupId === binding.browserGroupId);
    if (!target) throw new Error("协助页面已关闭、移动或不属于当前窗口；请取消请求并让 Agent 重新观察");
    const popup = terminalBrowserRuntime.popups.get(target.targetId);
    if (popup) {
      if (revealPopup === true) { popup.window.show(); popup.window.focus(); }
      return null;
    }
    return target.tabId;
  });
}
