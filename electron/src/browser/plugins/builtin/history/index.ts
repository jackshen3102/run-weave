import { dialog } from "electron";
import type { BrowserPlugin } from "../../contract.js";
import { attachBrowserHistory } from "./observer.js";
import {
  getBrowserHistoryStatus,
  setBrowserHistoryRecording,
  retryBrowserHistory,
  startBrowserHistory,
  closeBrowserHistory,
} from "./runtime.js";

export const historyPlugin: BrowserPlugin = {
  id: "history",
  name: "浏览记录",
  kind: "builtin",
  start: startBrowserHistory,
  stop: closeBrowserHistory,
  attach: attachBrowserHistory,
  status(profile) {
    const s = getBrowserHistoryStatus(profile);
    return {
      enabled: s.enabled,
      state: s.error ? "error" : s.enabled ? "ready" : "disabled",
      summary: s.error
        ? "保存异常"
        : !s.enabled
          ? "已暂停"
          : s.pending
            ? `待保存 ${s.pending}`
            : s.lastStoredAt
              ? "已落盘"
              : "等待新访问",
      detail: `${s.error ?? "保存正常"}\n待保存：${s.pending}\n最后落盘：${s.lastStoredAt ?? "暂无"}\n本机目录：${s.root}\n仅记录访问时间、标题和脱敏网址；不代表工作成果。`,
    };
  },
  commands(profile) {
    return [
      {
        id: "toggle",
        label: "记录新访问",
        checked: getBrowserHistoryStatus(profile).enabled,
      },
      { id: "status", label: "保存状态" },
      { id: "retry", label: "重试保存" },
    ];
  },
  async run({ window, profileId }, command) {
    if (command === "toggle")
      setBrowserHistoryRecording(
        profileId,
        !getBrowserHistoryStatus(profileId).enabled,
      );
    else if (command === "retry") await retryBrowserHistory(profileId);
    else if (command === "status") {
      const s = this.status(profileId);
      await dialog.showMessageBox(window, {
        type: s.state === "error" ? "warning" : "info",
        message: `${profileId} · 浏览记录 · ${s.summary}`,
        detail: s.detail,
      });
    }
  },
};
