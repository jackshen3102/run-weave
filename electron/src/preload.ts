import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  backendUrl: process.env.BROWSER_VIEWER_BACKEND_URL ?? "",
});
