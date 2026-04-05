import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  backendUrl: process.env.BROWSER_VIEWER_BACKEND_URL ?? "",
  openExternal: (url: string) =>
    ipcRenderer.invoke("viewer:open-external", url),
});
