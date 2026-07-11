import type { BrowserWindow } from "electron";
import type { PackagedBackendConnectionState } from "@runweave/shared/runtime-monitor";
import type { CdpProxyRuntime } from "./terminal-browser-cdp-proxy.js";
import type { PackagedBackendRuntime } from "./backend-runtime.js";
import type { DesktopIncidentLogger } from "./desktop-incident-logger.js";
import type { RuntimeRelease } from "./runtime-release.js";

export const desktopRuntime = {
  packagedBackend: null as PackagedBackendRuntime | null,
  cdpProxy: null as CdpProxyRuntime | null,
  mainWindow: null as BrowserWindow | null,
  activeRelease: null as RuntimeRelease | null,
  packagedBackendState: {
    kind: "packaged-local",
    available: false,
    backendUrl:
      process.env.RUNWEAVE_BACKEND_URL ??
      process.env.BROWSER_VIEWER_BACKEND_URL ??
      "",
    statusMessage: null,
    canReconnect: true,
    runtimeSource: null,
    runtimeReleaseId: null,
  } as PackagedBackendConnectionState,
  packagedBackendRestartPromise:
    null as Promise<PackagedBackendConnectionState> | null,
  expectedPackagedBackendExits: new WeakSet<object>(),
  packagedBackendsStoppedForQuit: false,
  stoppingPackagedBackendsForQuit: false,
  incidentLogger: null as DesktopIncidentLogger | null,
  appServerUnavailableDialogShown: false,
};
