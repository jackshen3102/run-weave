import { contextBridge, ipcRenderer, shell } from "electron";
import type {
  RunweaveCompanionBridge,
  RunweaveElectronBridge,
  TerminalBrowserAnnotationUpdate,
  TerminalBrowserBounds,
} from "@runweave/shared/desktop-bridge";
import type {
  TerminalBrowserCreateTabRequest,
  TerminalBrowserStateChangedEvent,
  TerminalBrowserWorkspaceSnapshot,
} from "@runweave/shared/terminal-browser-workspace";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "@runweave/shared/runtime-monitor";
import type { SystemMonitorSnapshot } from "@runweave/shared/system-monitor";
import type {
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
} from "@runweave/shared/terminal-browser-annotation";
import type { TerminalBrowserCdpProxyInfo } from "@runweave/shared/terminal-browser-cdp-proxy";
import type { TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import type { TerminalBrowserDisplayScaleState } from "@runweave/shared/terminal-browser-display-scale";
import type {
  TerminalBrowserMinimumViewportWidth,
  TerminalBrowserMinimumViewportWidthState,
} from "@runweave/shared/terminal-browser-minimum-width";
import type { TerminalBrowserHeaderState } from "@runweave/shared/terminal-browser-headers";
import type {
  ResolveTerminalBrowserProfileRequest,
  ResolvedTerminalBrowserProfile,
  TerminalBrowserProfileChangedEvent,
  TerminalBrowserProfileId,
  TerminalBrowserProfilePreferenceUpdate,
  TerminalBrowserProfilePreferences,
  TerminalBrowserProfileProxyMode,
  TerminalBrowserProfileRuntimeState,
} from "@runweave/shared/terminal-browser-profile";
import type {
  TerminalBrowserToolMenuAction,
  TerminalBrowserToolMenuRequest,
} from "@runweave/shared/terminal-browser-tool-menu";
import type {
  AttentionOpenDispatch,
  AttentionOpenIntent,
  AttentionOpenResult,
  CompanionWindowDragRequest,
} from "@runweave/shared/attention";

const companionApi = {
  reportContentSize: (size: { width: number; height: number }) =>
    ipcRenderer.invoke("attention:report-content-size", size) as Promise<void>,
  setMousePassthrough: (passthrough: boolean) =>
    ipcRenderer.invoke(
      "attention:set-mouse-passthrough",
      passthrough,
    ) as Promise<void>,
  dragWindow: (request: CompanionWindowDragRequest) =>
    ipcRenderer.send("attention:drag-window", request),
  openSlot: (intent: AttentionOpenIntent) =>
    ipcRenderer.invoke(
      "attention:open-slot",
      intent,
    ) as Promise<AttentionOpenResult>,
} satisfies RunweaveCompanionBridge;

const electronApi = {
  platform: process.platform,
  onAttentionOpenIntent: (
    listener: (intent: AttentionOpenDispatch) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      intent: AttentionOpenDispatch,
    ) => listener(intent);
    ipcRenderer.on("attention:open-intent", wrapped);
    return () => ipcRenderer.off("attention:open-intent", wrapped);
  },
  onAttentionOpenCancelled: (listener: (requestId: string) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, requestId: string) =>
      listener(requestId);
    ipcRenderer.on("attention:open-cancel", wrapped);
    return () => ipcRenderer.off("attention:open-cancel", wrapped);
  },
  authorizeAttentionCompletion: (result: AttentionOpenResult) =>
    ipcRenderer.invoke(
      "attention:authorize-completion",
      result,
    ) as Promise<boolean>,
  reportAttentionOpenResult: (result: AttentionOpenResult) =>
    ipcRenderer.invoke("attention:open-result", result) as Promise<void>,
  isElectron: true,
  managesPackagedBackend:
    (process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND ??
      process.env.BROWSER_VIEWER_MANAGES_PACKAGED_BACKEND) === "true",
  backendUrl:
    process.env.RUNWEAVE_BACKEND_URL ??
    process.env.BROWSER_VIEWER_BACKEND_URL ??
    "",
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
  checkAppServer: () =>
    ipcRenderer.invoke("viewer:check-app-server") as Promise<boolean>,
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
  terminalBrowserGetWorkspace: (profileId: TerminalBrowserProfileId) =>
    ipcRenderer.invoke(
      "terminal-browser:get-workspace",
      profileId,
    ) as Promise<TerminalBrowserWorkspaceSnapshot>,
  terminalBrowserCreateTab: (request: TerminalBrowserCreateTabRequest) =>
    ipcRenderer.invoke("terminal-browser:create-tab", request) as Promise<void>,
  terminalBrowserRenameGroup: (
    profileId: TerminalBrowserProfileId,
    groupId: string,
    name: string,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:rename-group",
      profileId,
      groupId,
      name,
    ) as Promise<void>,
  terminalBrowserCloseGroup: (
    profileId: TerminalBrowserProfileId,
    groupId: string,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:close-group",
      profileId,
      groupId,
    ) as Promise<void>,
  terminalBrowserReorderGroupTabs: (
    profileId: TerminalBrowserProfileId,
    groupId: string,
    orderedTabIds: string[],
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:reorder-group-tabs",
      profileId,
      groupId,
      orderedTabIds,
    ) as Promise<void>,
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
  terminalBrowserSetDisplayScale: (tabId: string, factor: number) =>
    ipcRenderer.invoke(
      "terminal-browser:set-display-scale",
      tabId,
      factor,
    ) as Promise<TerminalBrowserDisplayScaleState>,
  terminalBrowserSetMinimumViewportWidth: (
    tabId: string,
    width: TerminalBrowserMinimumViewportWidth,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:set-minimum-viewport-width",
      tabId,
      width,
    ) as Promise<TerminalBrowserMinimumViewportWidthState>,
  terminalBrowserSetBounds: (
    tabId: string,
    bounds: TerminalBrowserBounds | null,
  ) => ipcRenderer.invoke("terminal-browser:set-bounds", tabId, bounds),
  terminalBrowserOpenDevTools: (tabId: string) =>
    ipcRenderer.invoke("terminal-browser:open-devtools", tabId),
  terminalBrowserOpenToolMenu: (request: TerminalBrowserToolMenuRequest) =>
    ipcRenderer.invoke(
      "terminal-browser:open-tool-menu",
      request,
    ) as Promise<TerminalBrowserToolMenuAction | null>,
  terminalBrowserGetCdpProxyInfo: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:get-cdp-proxy-info",
      tabId,
    ) as Promise<TerminalBrowserCdpProxyInfo>,
  terminalBrowserGetHeaderRules: (profileId: TerminalBrowserProfileId) =>
    ipcRenderer.invoke(
      "terminal-browser:get-header-rules",
      profileId,
    ) as Promise<TerminalBrowserHeaderState>,
  terminalBrowserSetHeaderRules: (
    profileId: TerminalBrowserProfileId,
    rules: TerminalBrowserHeaderState["rules"],
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:set-header-rules",
      profileId,
      rules,
    ) as Promise<TerminalBrowserHeaderState>,
  terminalBrowserGetProfilePreferences: () =>
    ipcRenderer.invoke(
      "terminal-browser:get-profile-preferences",
    ) as Promise<TerminalBrowserProfilePreferences>,
  terminalBrowserUpdateProfilePreferences: (
    update: TerminalBrowserProfilePreferenceUpdate,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:update-profile-preferences",
      update,
    ) as Promise<TerminalBrowserProfilePreferences>,
  terminalBrowserGetProfileRuntimes: () =>
    ipcRenderer.invoke("terminal-browser:get-profile-runtimes") as Promise<
      TerminalBrowserProfileRuntimeState[]
    >,
  terminalBrowserSetProfileProxyMode: (
    profileId: TerminalBrowserProfileId,
    proxyMode: TerminalBrowserProfileProxyMode,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:set-profile-proxy-mode",
      profileId,
      proxyMode,
    ) as Promise<TerminalBrowserProfileRuntimeState>,
  terminalBrowserResolveProfile: (
    request: ResolveTerminalBrowserProfileRequest,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:resolve-profile",
      request,
    ) as Promise<ResolvedTerminalBrowserProfile>,
  terminalBrowserOpenWhistleConsole: (profileId: TerminalBrowserProfileId) =>
    ipcRenderer.invoke(
      "terminal-browser:open-whistle-console",
      profileId,
    ) as Promise<void>,
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
  terminalBrowserAnnotationSetSelecting: (tabId: string, selecting: boolean) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-set-selecting",
      tabId,
      selecting,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationSetSubmitting: (
    tabId: string,
    submitting: boolean,
  ) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-set-submitting",
      tabId,
      submitting,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationDelete: (tabId: string, annotationId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-delete",
      tabId,
      annotationId,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationFocus: (tabId: string, annotationId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-focus",
      tabId,
      annotationId,
    ) as Promise<TerminalBrowserAnnotationState>,
  terminalBrowserAnnotationSubmit: (tabId: string) =>
    ipcRenderer.invoke(
      "terminal-browser:annotation-submit",
      tabId,
    ) as Promise<TerminalBrowserAnnotationSubmission>,
  onTerminalBrowserStateChanged: (
    listener: (data: TerminalBrowserStateChangedEvent) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: TerminalBrowserStateChangedEvent,
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:state-changed", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:state-changed", wrapped);
    };
  },
  onTerminalBrowserProfileChanged: (
    listener: (data: TerminalBrowserProfileChangedEvent) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: TerminalBrowserProfileChangedEvent,
    ) => listener(data);
    ipcRenderer.on("terminal-browser:profile-changed", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:profile-changed", wrapped);
    };
  },
  onTerminalBrowserAnnotationUpdated: (
    listener: (data: TerminalBrowserAnnotationUpdate) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      data: TerminalBrowserAnnotationUpdate,
    ) => {
      listener(data);
    };
    ipcRenderer.on("terminal-browser:annotation-updated", wrapped);
    return () => {
      ipcRenderer.off("terminal-browser:annotation-updated", wrapped);
    };
  },
  beep: () => shell.beep(),
} satisfies RunweaveElectronBridge;

contextBridge.exposeInMainWorld("companionAPI", companionApi);
contextBridge.exposeInMainWorld("electronAPI", electronApi);
