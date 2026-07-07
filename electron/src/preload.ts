import { contextBridge, ipcRenderer, shell } from "electron";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
  SystemMonitorSnapshot,
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
  TerminalBrowserCdpProxyInfo,
  TerminalBrowserDeviceState,
  TerminalBrowserHeaderState,
  TerminalBrowserProxyState,
} from "@runweave/shared";

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
  reloadRuntime: () =>
    ipcRenderer.invoke(
      "viewer:reload-runtime",
    ) as Promise<PackagedBackendConnectionState>,
  openExternal: (url: string) =>
    ipcRenderer.invoke("viewer:open-external", url),
  getRuntimeStats: () =>
    ipcRenderer.invoke(
      "viewer:get-runtime-stats",
    ) as Promise<RuntimeStatsSnapshot>,
  getSystemMonitorSnapshot: () =>
    ipcRenderer.invoke("system-monitor:get") as Promise<SystemMonitorSnapshot>,
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
        mcpActivityUntil: number | null;
        devtoolsOpen: boolean;
        deviceState: TerminalBrowserDeviceState;
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
  terminalBrowserGetDeviceState: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:get-device-state",
      tabId,
    ) as Promise<TerminalBrowserDeviceState>,
  terminalBrowserSetDeviceState: (tabId: string, presetId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:set-device-state",
      tabId,
      presetId,
    ) as Promise<TerminalBrowserDeviceState>,
  terminalBrowserSetBounds: (
    tabId: string,
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
      emulationScale?: number;
    } | null,
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
  terminalBrowserGetHeaderRules: () =>
    ipcRenderer.invoke(
      "terminal-browser:get-header-rules",
    ) as Promise<TerminalBrowserHeaderState>,
  terminalBrowserSetHeaderRules: (rules: TerminalBrowserHeaderState["rules"]) =>
    ipcRenderer.invoke(
      "terminal-browser:set-header-rules",
      rules,
    ) as Promise<TerminalBrowserHeaderState>,
  terminalBrowserCloseTab: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:close-tab", tabId),
  terminalBrowserAnnotationStart: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-start",
      tabId,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationStop: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-stop",
      tabId,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationList: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-list",
      tabId,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationDelete: (tabId: string, annotationId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-delete",
      tabId,
      annotationId,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationSubmit: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-submit",
      tabId,
    ) as Promise<TerminalBrowserAnnotationSubmission>,
  onTerminalBrowserTabCreatedFromProxy: (
    listener: (data: {
      tabId: string;
      browserGroupId: string;
      url: string;
      title: string;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string;
        browserGroupId: string;
        url: string;
        title: string;
      },
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
      browserGroupId: string;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
      cdpProxyAttached: boolean;
      mcpActivityUntil: number | null;
      devtoolsOpen: boolean;
      deviceState: TerminalBrowserDeviceState;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string;
        browserGroupId: string;
        url: string;
        title: string;
        canGoBack: boolean;
        canGoForward: boolean;
        loading: boolean;
        cdpProxyAttached: boolean;
        mcpActivityUntil: number | null;
        devtoolsOpen: boolean;
        deviceState: TerminalBrowserDeviceState;
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
      browserGroupId: string;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
      cdpProxyAttached: boolean;
      mcpActivityUntil: number | null;
      devtoolsOpen: boolean;
      deviceState: TerminalBrowserDeviceState;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string;
        browserGroupId: string;
        url: string;
        title: string;
        canGoBack: boolean;
        canGoForward: boolean;
        loading: boolean;
        cdpProxyAttached: boolean;
        mcpActivityUntil: number | null;
        devtoolsOpen: boolean;
        deviceState: TerminalBrowserDeviceState;
      },
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:tab-activated-from-proxy", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:tab-activated-from-proxy", wrapped);
    };
  },
  onTerminalBrowserTabClosed: (listener: (data: { tabId: string }) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string },
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:tab-closed", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:tab-closed", wrapped);
    };
  },
  onTerminalBrowserAnnotationUpdated: (
    listener: (data: {
      tabId: string;
      state: TerminalBrowserAnnotationState;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; state: TerminalBrowserAnnotationState },
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:annotation-updated", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:annotation-updated", wrapped);
    };
  },
  beep: () => shell.beep(),
});
