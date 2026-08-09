import type {
  AttentionOpenDispatch,
  AttentionOpenIntent,
  AttentionOpenResult,
  CompanionWindowDragRequest,
} from "./attention";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "./runtime-monitor";
import type { SystemMonitorSnapshot } from "./system-monitor";
import type {
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
} from "./terminal-browser-annotation";
import type { TerminalBrowserCdpProxyInfo } from "./terminal-browser-cdp-proxy";
import type {
  TerminalBrowserDevicePresetId,
  TerminalBrowserDeviceState,
} from "./terminal-browser-device";
import type { TerminalBrowserDisplayScaleState } from "./terminal-browser-display-scale";
import type { TerminalBrowserHeaderState } from "./terminal-browser-headers";
import type { TerminalBrowserProxyState } from "./terminal-browser-proxy";
import type {
  TerminalBrowserToolMenuAction,
  TerminalBrowserToolMenuRequest,
} from "./terminal-browser-tool-menu";

export interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  emulationScale?: number;
}

export interface TerminalBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TerminalBrowserUpdate extends TerminalBrowserSnapshot {
  tabId: string;
  browserGroupId: string;
  loading: boolean;
  cdpProxyAttached: boolean;
  mcpActivityUntil: number | null;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
  displayScale: number;
}

export interface TerminalBrowserTabSnapshot extends TerminalBrowserUpdate {
  active: boolean;
}

export interface TerminalBrowserCreatedTab {
  tabId: string;
  browserGroupId: string;
  url: string;
  title: string;
  openerTabId?: string;
  displayScale: number;
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
  openMainWindow: () => Promise<void>;
}

export interface RunweaveElectronBridge {
  platform: string;
  isElectron: boolean;
  managesPackagedBackend: boolean;
  backendUrl: string;
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
  getPackagedBackendState: () => Promise<PackagedBackendConnectionState>;
  onPackagedBackendStateChange: (
    listener: (state: PackagedBackendConnectionState) => void,
  ) => () => void;
  restartPackagedBackend: () => Promise<PackagedBackendConnectionState>;
  reloadRuntime: () => Promise<PackagedBackendConnectionState>;
  checkAppServer: () => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  getRuntimeStats: () => Promise<RuntimeStatsSnapshot>;
  getSystemMonitorSnapshot: () => Promise<SystemMonitorSnapshot>;
  terminalBrowserNavigate: (
    tabId: string,
    url: string,
  ) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserListTabs: () => Promise<TerminalBrowserTabSnapshot[]>;
  terminalBrowserReorderTabs: (orderedTabIds: string[]) => Promise<void>;
  terminalBrowserReload: (tabId: string) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserStop: (tabId: string) => Promise<void>;
  terminalBrowserGoBack: (tabId: string) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserGoForward: (tabId: string) => Promise<TerminalBrowserSnapshot>;
  terminalBrowserShow: (tabId: string) => Promise<void>;
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
  terminalBrowserGetProxyState: () => Promise<TerminalBrowserProxyState>;
  terminalBrowserSetProxyEnabled: (
    enabled: boolean,
  ) => Promise<TerminalBrowserProxyState>;
  terminalBrowserGetHeaderRules: () => Promise<TerminalBrowserHeaderState>;
  terminalBrowserSetHeaderRules: (
    rules: TerminalBrowserHeaderState["rules"],
  ) => Promise<TerminalBrowserHeaderState>;
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
  onTerminalBrowserTabCreatedFromProxy: (
    listener: (data: TerminalBrowserCreatedTab) => void,
  ) => () => void;
  onTerminalBrowserTabUpdated: (
    listener: (data: TerminalBrowserUpdate) => void,
  ) => () => void;
  onTerminalBrowserTabActivatedFromProxy: (
    listener: (data: TerminalBrowserUpdate) => void,
  ) => () => void;
  onTerminalBrowserTabClosed: (
    listener: (data: { tabId: string }) => void,
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
