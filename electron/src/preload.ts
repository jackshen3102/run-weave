import { contextBridge, ipcRenderer, shell } from "electron";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "@browser-viewer/shared";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  managesPackagedBackend:
    process.env.BROWSER_VIEWER_MANAGES_PACKAGED_BACKEND === "true",
  backendUrl: process.env.BROWSER_VIEWER_BACKEND_URL ?? "",
  getPackagedBackendState: () =>
    ipcRenderer.invoke(
      "viewer:get-packaged-backend-state",
    ) as Promise<PackagedBackendConnectionState>,
  onPackagedBackendStateChange: (
    listener: (state: PackagedBackendConnectionState) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      state: PackagedBackendConnectionState,
    ) => {
      listener(state);
    };

    ipcRenderer.on("viewer:packaged-backend-state", wrapped);
    return () => {
      ipcRenderer.off("viewer:packaged-backend-state", wrapped);
    };
  },
  restartPackagedBackend: () =>
    ipcRenderer.invoke(
      "viewer:restart-packaged-backend",
    ) as Promise<PackagedBackendConnectionState>,
  openExternal: (url: string) =>
    ipcRenderer.invoke("viewer:open-external", url),
  getRuntimeStats: () =>
    ipcRenderer.invoke("viewer:get-runtime-stats") as Promise<RuntimeStatsSnapshot>,
  beep: () => shell.beep(),
});
