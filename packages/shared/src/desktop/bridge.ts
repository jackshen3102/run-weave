import type { TunnelSnapshot, TunnelConfigUpdate, TunnelImport, TunnelLogin } from "../tunnels/index";
import type { LoginResponse } from "../protocol";
import type { SuijiDesktopState, SuijiEnvironment, SuijiProfile } from "../suiji/desktop";
import type { RemoteServiceRef, ResolvedServiceAccess } from "../remote/index";
import type { BrowserAssistanceTarget } from "../browser/assistance";
import type {
  AttentionOpenDispatch,
  AttentionOpenIntent,
  AttentionOpenResult,
  AttentionNotificationTarget,
  CompanionPresentationState,
  CompanionWindowDragRequest,
} from "../attention";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "../monitoring/runtime";
import type { SystemMonitorSnapshot } from "../monitoring/system";
import type {
  RuntimeStatusCapabilityId,
  RuntimeStatusReport,
} from "../monitoring/runtime-status";
import type {
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
} from "../browser/annotation";
import type { TerminalBrowserCdpProxyInfo } from "../browser/cdp-proxy";
import type {
  TerminalBrowserAutomationFrame,
  TerminalBrowserAutomationFrameAcknowledgeRequest,
  TerminalBrowserAutomationSnapshot,
  TerminalBrowserAutomationViewStateRequest,
} from "../browser/automation";
import type {
  TerminalBrowserDevicePresetId,
  TerminalBrowserDeviceState,
} from "../browser/device";
import type { TerminalBrowserDisplayScaleState } from "../browser/display-scale";
import type { TerminalBrowserHeaderState } from "../browser/headers";
import type {
  TerminalBrowserMinimumViewportWidth,
  TerminalBrowserMinimumViewportWidthState,
} from "../browser/minimum-width";
import type {
  ResolveTerminalBrowserProfileRequest,
  ResolvedTerminalBrowserProfile,
  TerminalBrowserProfileChangedEvent,
  TerminalBrowserProfileId,
  TerminalBrowserProfilePreferenceUpdate,
  TerminalBrowserProfilePreferences,
  TerminalBrowserProfileProxyMode,
  TerminalBrowserProfileRuntimeState,
} from "../browser/profile";
import type {
  TerminalBrowserToolMenuAction,
  TerminalBrowserToolMenuRequest,
} from "../browser/tool-menu";
import type {
  TerminalBrowserCreateTabRequest,
  TerminalBrowserStateChangedEvent,
  TerminalBrowserSnapshot,
  TerminalBrowserWorkspaceSnapshot,
} from "../browser/workspace";
export type {
  TerminalBrowserSnapshot,
  TerminalBrowserTabSnapshot,
  TerminalBrowserUpdate,
} from "../browser/workspace";

/** Per-renderer-document revision; host identity comes from the IPC sender. */
export interface TerminalBrowserPresentationState {
  revision: number;
  active: boolean;
  suppressed: boolean;
}

export interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  emulationScale?: number;
  horizontalOffsetX?: number;
}

export interface TerminalBrowserAnnotationUpdate {
  tabId: string;
  state: TerminalBrowserAnnotationState;
}

export interface RunweaveCompanionBridge {
  reportContentSize: (size: { width: number; height: number }) => Promise<void>;
  setMousePassthrough: (passthrough: boolean) => Promise<void>;
  dragWindow: (request: CompanionWindowDragRequest) => void;
  openSlot: (intent: AttentionOpenIntent) => Promise<AttentionOpenResult>;
}

export interface RunweaveElectronBridge {
  platform: string;
  isElectron: boolean;
  showAttentionNotification: (target: AttentionNotificationTarget) => Promise<boolean>;
  onAttentionNotificationOpen: (listener: (target: AttentionNotificationTarget) => void) => () => void;
  listTunnels: () => Promise<TunnelSnapshot>;
  saveTunnels: (input: TunnelConfigUpdate) => Promise<TunnelSnapshot>;
  connectTunnel: (hostId: string) => Promise<void>;
  disconnectTunnel: (hostId: string) => Promise<void>;
  retryTunnel: (hostId: string, forwardId?: string) => Promise<void>;
  loginTunnelBrowser: (input: TunnelLogin) => Promise<{persistent: boolean}>;
  selectTunnelBrowser: (hostId: string, terminalId: string) => Promise<void>;
  importTunnels: (input: TunnelImport) => Promise<TunnelSnapshot>;
  onTunnelsChanged: (listener: (snapshot: TunnelSnapshot) => void) => () => void;
  onTunnelNotice: (listener: (message: string) => void) => () => void;
  onOpenTunnels: (listener: () => void) => () => void;
  resolveTunnelService: (ref: RemoteServiceRef, token: string) => Promise<ResolvedServiceAccess>;
  managesPackagedBackend: boolean;
  backendUrl: string;
  getDevSessionAuth: (backendUrl: string) => Promise<LoginResponse>;
  onAttentionOpenIntent: (
    listener: (intent: AttentionOpenDispatch) => void,
  ) => () => void;
  onAttentionOpenCancelled: (
    listener: (requestId: string) => void,
  ) => () => void;
  authorizeAttentionCompletion: (
    result: AttentionOpenResult,
  ) => Promise<boolean>;
  reportAttentionOpenResult: (result: AttentionOpenResult) => Promise<void>;
  getCompanionEnabled: () => Promise<boolean>;
  onCompanionEnabledChanged: (
    listener: (enabled: boolean) => void,
  ) => () => void;
  publishCompanionPresentation: (
    presentation: CompanionPresentationState,
  ) => Promise<void>;
  getPackagedBackendState: () => Promise<PackagedBackendConnectionState>;
  onPackagedBackendStateChange: (
    listener: (state: PackagedBackendConnectionState) => void,
  ) => () => void;
  restartPackagedBackend: () => Promise<PackagedBackendConnectionState>;
  reloadRuntime: () => Promise<PackagedBackendConnectionState>;
  checkAppServer: () => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  selectProjectDirectory: (defaultPath?: string) => Promise<string | null>;
  loadSuijiState: () => Promise<SuijiDesktopState>;
  saveSuijiProfile: (environment: SuijiEnvironment, profile: SuijiProfile) => Promise<void>;
  selectSuijiEnvironment: (environment: SuijiEnvironment) => Promise<void>;
  getRuntimeStats: () => Promise<RuntimeStatsSnapshot>;
  getSystemMonitorSnapshot: () => Promise<SystemMonitorSnapshot>;
  getRuntimeStatusReport: () => Promise<RuntimeStatusReport>;
  copyRuntimeStatusText: (value: string) => Promise<boolean>;
  showRuntimeStatusNotification: (input: {
    capabilityId: RuntimeStatusCapabilityId;
    title: string;
    body: string;
  }) => Promise<boolean>;
  terminalBrowserNavigate: (
    tabId: string,
    url: string,
  ) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserGetWorkspace: (
    profileId: TerminalBrowserProfileId,
  ) => Promise<TerminalBrowserWorkspaceSnapshot>;
  terminalBrowserCreateTab: (
    request: TerminalBrowserCreateTabRequest,
  ) => Promise<void>;
  terminalBrowserRenameGroup: (
    profileId: TerminalBrowserProfileId,
    groupId: string,
    name: string,
  ) => Promise<void>;
  terminalBrowserCloseGroup: (
    profileId: TerminalBrowserProfileId,
    groupId: string,
  ) => Promise<void>;
  terminalBrowserReorderGroupTabs: (
    profileId: TerminalBrowserProfileId,
    groupId: string,
    orderedTabIds: string[],
  ) => Promise<void>;
  terminalBrowserReload: (tabId: string) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserStop: (tabId: string) => Promise<void>;
  terminalBrowserGoBack: (tabId: string) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserGoForward: (tabId: string) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserSetPresentation: (state: TerminalBrowserPresentationState) => Promise<void>;
  terminalBrowserShow: (tabId: string) => Promise<void>;
  terminalBrowserResolveAssistanceTarget: (
    target: BrowserAssistanceTarget,
  ) => Promise<string>;
  terminalBrowserHide: (tabId: string) => Promise<void>;
  terminalBrowserGetDeviceState: (
    tabId: string,
  ) => Promise<TerminalBrowserDeviceState>;
  terminalBrowserSetDeviceState: (
    tabId: string,
    presetId: TerminalBrowserDevicePresetId,
  ) => Promise<TerminalBrowserDeviceState>;
  terminalBrowserSetDisplayScale: (
    tabId: string,
    factor: number,
  ) => Promise<TerminalBrowserDisplayScaleState>;
  terminalBrowserSetMinimumViewportWidth: (
    tabId: string,
    width: TerminalBrowserMinimumViewportWidth,
  ) => Promise<TerminalBrowserMinimumViewportWidthState>;
  terminalBrowserSetBounds: (
    tabId: string,
    bounds: TerminalBrowserBounds | null,
  ) => Promise<void>;
  terminalBrowserOpenDevTools: (tabId: string) => Promise<void>;
  terminalBrowserOpenToolMenu: (
    request: TerminalBrowserToolMenuRequest,
  ) => Promise<TerminalBrowserToolMenuAction | null>;
  terminalBrowserGetCdpProxyInfo: (
    tabId: string,
  ) => Promise<TerminalBrowserCdpProxyInfo>;
  terminalBrowserGetHeaderRules: (
    profileId: TerminalBrowserProfileId,
  ) => Promise<TerminalBrowserHeaderState>;
  terminalBrowserSetHeaderRules: (
    profileId: TerminalBrowserProfileId,
    rules: TerminalBrowserHeaderState["rules"],
  ) => Promise<TerminalBrowserHeaderState>;
  terminalBrowserRestoreProfilePreferences: () => Promise<TerminalBrowserProfilePreferences>;
  terminalBrowserGetProfilePreferences: () => Promise<TerminalBrowserProfilePreferences>;
  terminalBrowserUpdateProfilePreferences: (
    update: TerminalBrowserProfilePreferenceUpdate,
  ) => Promise<TerminalBrowserProfilePreferences>;
  terminalBrowserGetProfileRuntimes: () => Promise<
    TerminalBrowserProfileRuntimeState[]
  >;
  terminalBrowserSetProfileProxyMode: (
    profileId: TerminalBrowserProfileId,
    proxyMode: TerminalBrowserProfileProxyMode,
  ) => Promise<TerminalBrowserProfileRuntimeState>;
  terminalBrowserResolveProfile: (
    request: ResolveTerminalBrowserProfileRequest,
  ) => Promise<ResolvedTerminalBrowserProfile>;
  terminalBrowserAutomationGetSnapshot: () => Promise<TerminalBrowserAutomationSnapshot>;
  terminalBrowserAutomationSetViewState: (
    request: TerminalBrowserAutomationViewStateRequest,
  ) => Promise<void>;
  terminalBrowserAutomationAcknowledgeFrame: (
    request: TerminalBrowserAutomationFrameAcknowledgeRequest,
  ) => Promise<void>;
  onTerminalBrowserAutomationStateChanged: (
    listener: (snapshot: TerminalBrowserAutomationSnapshot) => void,
  ) => () => void;
  onTerminalBrowserAutomationFrame: (
    listener: (frame: TerminalBrowserAutomationFrame) => void,
  ) => () => void;
  terminalBrowserOpenWhistleConsole: (
    profileId: TerminalBrowserProfileId,
  ) => Promise<void>;
  terminalBrowserCloseTab: (tabId: string) => Promise<void>;
  terminalBrowserAnnotationStart: (
    tabId: string,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationStop: (
    tabId: string,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationList: (
    tabId: string,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationSetSelecting: (
    tabId: string,
    selecting: boolean,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationSetSubmitting: (
    tabId: string,
    submitting: boolean,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationDelete: (
    tabId: string,
    annotationId: string,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationFocus: (
    tabId: string,
    annotationId: string,
  ) => Promise<TerminalBrowserAnnotationState>;
  terminalBrowserAnnotationSubmit: (
    tabId: string,
  ) => Promise<TerminalBrowserAnnotationSubmission>;
  onTerminalBrowserStateChanged: (
    listener: (event: TerminalBrowserStateChangedEvent) => void,
  ) => () => void;
  onTerminalBrowserProfileChanged: (
    listener: (event: TerminalBrowserProfileChangedEvent) => void,
  ) => () => void;
  onTerminalBrowserAnnotationUpdated: (
    listener: (data: TerminalBrowserAnnotationUpdate) => void,
  ) => () => void;
  beep: () => void;
}

export type RunweaveElectronHostBridge = Pick<
  RunweaveElectronBridge,
  "isElectron" | "platform"
> &
  Partial<Omit<RunweaveElectronBridge, "isElectron" | "platform">>;
