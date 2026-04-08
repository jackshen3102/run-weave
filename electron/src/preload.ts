import { contextBridge, ipcRenderer, shell } from "electron";
import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  backendUrl: process.env.BROWSER_VIEWER_BACKEND_URL ?? "",
  openExternal: (url: string) =>
    ipcRenderer.invoke("viewer:open-external", url),
  getRuntimeStats: () =>
    ipcRenderer.invoke("viewer:get-runtime-stats") as Promise<RuntimeStatsSnapshot>,
  beep: () => shell.beep(),
});
