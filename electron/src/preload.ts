import { contextBridge, ipcRenderer, shell } from "electron";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
  TerminalBrowserCdpProxyInfo,
  TerminalBrowserProxyState,
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
  terminalBrowserNavigate: (tabId: string, url: string) =>
    ipcRenderer.invoke("terminal-browser:navigate", tabId, url),
  terminalBrowserListTabs: () =>
    ipcRenderer.invoke("terminal-browser:list-tabs") as Promise<
      Array<{
        tabId: string;
        url: string;
        title: string;
        canGoBack: boolean;
        canGoForward: boolean;
        loading: boolean;
        active: boolean;
        cdpProxyAttached: boolean;
        devtoolsOpen: boolean;
      }>
    >,
  terminalBrowserReload: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:reload", tabId),
  terminalBrowserStop: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:stop", tabId),
  terminalBrowserGoBack: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:go-back", tabId),
  terminalBrowserGoForward: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:go-forward", tabId),
  terminalBrowserShow: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:show", tabId),
  terminalBrowserHide: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:hide", tabId),
  terminalBrowserSetBounds: (
    tabId: string,
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => ipcRenderer.invoke("terminal-browser:set-bounds", tabId, bounds),
  terminalBrowserOpenDevTools: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:open-devtools", tabId),
  terminalBrowserGetCdpProxyInfo: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:get-cdp-proxy-info",
      tabId,
    ) as Promise<TerminalBrowserCdpProxyInfo>,
  terminalBrowserGetProxyState: () =>
    ipcRenderer.invoke(
      "terminal-browser:get-proxy-state",
    ) as Promise<TerminalBrowserProxyState>,
  terminalBrowserSetProxyEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(
      "terminal-browser:set-proxy-enabled",
      enabled,
    ) as Promise<TerminalBrowserProxyState>,
  terminalBrowserCloseTab: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:close-tab", tabId),
  onTerminalBrowserTabCreatedFromProxy: (
    listener: (data: { tabId: string; url: string; title: string }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; url: string; title: string },
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:tab-created-from-proxy", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:tab-created-from-proxy", wrapped);
    };
  },
  onTerminalBrowserTabUpdated: (
    listener: (data: {
      tabId: string;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string;
        url: string;
        title: string;
        canGoBack: boolean;
        canGoForward: boolean;
        loading: boolean;
      },
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:tab-updated", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:tab-updated", wrapped);
    };
  },
  onTerminalBrowserTabActivatedFromProxy: (
    listener: (data: {
      tabId: string;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string;
        url: string;
        title: string;
        canGoBack: boolean;
        canGoForward: boolean;
        loading: boolean;
      },
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:tab-activated-from-proxy", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:tab-activated-from-proxy", wrapped);
    };
  },
  beep: () => shell.beep(),
});
