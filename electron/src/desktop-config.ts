import { app, protocol } from "electron";
import os from "node:os";
import path from "node:path";

declare const __RUNWEAVE_DESKTOP_CHANNEL__: "stable" | "beta";
declare const __RUNWEAVE_DESKTOP_SOURCE_REVISION__: string;
declare const __RUNWEAVE_DESKTOP_INSTANCE_ID__: string | null;
declare const __RUNWEAVE_DEV_SESSION_ID__: string | null;
declare const __RUNWEAVE_DESKTOP_USER_DATA_DIR__: string | null;
declare const __RUNWEAVE_DESKTOP_STATUS_PATH__: string | null;
declare const __RUNWEAVE_DESKTOP_CDP_PORT__: string | null;
declare const __RUNWEAVE_TERMINAL_BROWSER_CDP_PORT__: string | null;
declare const __RUNWEAVE_APP_SERVER_HOME__: string | null;

export const desktopChannel = __RUNWEAVE_DESKTOP_CHANNEL__;
export const desktopSourceRevision = __RUNWEAVE_DESKTOP_SOURCE_REVISION__;
export const isBetaChannel = desktopChannel === "beta";
export const BETA_DESKTOP_CDP_PORT = 9335;
const desktopInstanceId =
  process.env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() ||
  __RUNWEAVE_DESKTOP_INSTANCE_ID__;
const explicitUserDataPath =
  process.env.RUNWEAVE_DESKTOP_USER_DATA_DIR?.trim() ||
  __RUNWEAVE_DESKTOP_USER_DATA_DIR__;
const configuredDesktopCdpPort = parseOptionalPort(
  process.env.RUNWEAVE_DESKTOP_CDP_PORT ??
    __RUNWEAVE_DESKTOP_CDP_PORT__ ??
    undefined,
);

if (desktopInstanceId) {
  process.env.RUNWEAVE_DESKTOP_INSTANCE_ID = desktopInstanceId;
}
if (__RUNWEAVE_DEV_SESSION_ID__) {
  process.env.RUNWEAVE_DEV_SESSION_ID ??= __RUNWEAVE_DEV_SESSION_ID__;
}
process.env.RUNWEAVE_SOURCE_REVISION ??= desktopSourceRevision;
if (__RUNWEAVE_DESKTOP_STATUS_PATH__) {
  process.env.RUNWEAVE_DESKTOP_STATUS_PATH ??=
    __RUNWEAVE_DESKTOP_STATUS_PATH__;
}
if (__RUNWEAVE_TERMINAL_BROWSER_CDP_PORT__) {
  process.env.RUNWEAVE_TERMINAL_BROWSER_CDP_PROXY_PORT ??=
    __RUNWEAVE_TERMINAL_BROWSER_CDP_PORT__;
}
if (__RUNWEAVE_APP_SERVER_HOME__) {
  process.env.RUNWEAVE_APP_SERVER_HOME ??= __RUNWEAVE_APP_SERVER_HOME__;
}

if (explicitUserDataPath) {
  app.setPath("userData", path.resolve(explicitUserDataPath));
}

if (isBetaChannel) {
  app.setName(
    desktopInstanceId ? `Runweave Beta ${desktopInstanceId}` : "Runweave Beta",
  );
  if (!explicitUserDataPath) {
    app.setPath("userData", path.join(app.getPath("appData"), "Runweave Beta"));
  }
}

const desktopCdpPort =
  configuredDesktopCdpPort ?? (isBetaChannel ? BETA_DESKTOP_CDP_PORT : null);
export const desktopCdpEndpoint = desktopCdpPort
  ? `http://127.0.0.1:${desktopCdpPort}`
  : null;
export const betaDesktopCdpEndpoint = isBetaChannel ? desktopCdpEndpoint : null;

if (desktopCdpPort) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(desktopCdpPort));
}

if (isBetaChannel) {
  process.env.RUNWEAVE_DESKTOP_CHANNEL = "beta";
  process.env.BROWSER_PROFILE_DIR ??= path.join(
    app.getPath("userData"),
    "browser-profile",
  );
  process.env.AUTH_STORE_FILE ??= path.join(
    process.env.BROWSER_PROFILE_DIR,
    "auth-store.json",
  );
  process.env.RUNWEAVE_CONFIG_FILE ??= path.join(
    app.getPath("userData"),
    "cli",
    "config.json",
  );
  delete process.env.RUNWEAVE_ACCESS_TOKEN;
  process.env.RUNWEAVE_APP_SERVER_HOME ??= path.join(
    os.homedir(),
    ".runweave",
    "app-server-beta",
  );
  process.env.RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR ??= path.join(
    process.env.RUNWEAVE_APP_SERVER_HOME,
    "cloud-sync",
  );
}

function parseOptionalPort(raw: string | undefined): number | null {
  if (!raw?.trim()) {
    return null;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid RUNWEAVE_DESKTOP_CDP_PORT: ${raw}`);
  }
  return port;
}

export const isDev = !app.isPackaged;
export const managesPackagedBackend = isDev
  ? false
  : process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND?.trim() !== "false";
process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND = String(
  managesPackagedBackend,
);

export const DEV_SERVER_URL =
  process.env.RUNWEAVE_DEV_URL ??
  process.env.BROWSER_VIEWER_DEV_URL ??
  "http://127.0.0.1:5173";

export const DEV_RENDERER_DIST = process.env.RUNWEAVE_RENDERER_DIST_DIR
  ? path.resolve(process.env.RUNWEAVE_RENDERER_DIST_DIR)
  : path.join(__dirname, "../../frontend/dist");
export const PRELOAD_PATH = process.env.RUNWEAVE_ELECTRON_PRELOAD_PATH
  ? path.resolve(process.env.RUNWEAVE_ELECTRON_PRELOAD_PATH)
  : path.join(__dirname, "preload.cjs");
export const DEV_DOCK_ICON_PATH = process.env.RUNWEAVE_ELECTRON_DOCK_ICON_PATH
  ? path.resolve(process.env.RUNWEAVE_ELECTRON_DOCK_ICON_PATH)
  : path.join(__dirname, "../resources/icons/icon-preview.png");

export const CUSTOM_PROTOCOL = "runweave";
export const LEGACY_CUSTOM_PROTOCOL = "browser-viewer";

protocol.registerSchemesAsPrivileged([
  ...[CUSTOM_PROTOCOL, LEGACY_CUSTOM_PROTOCOL].map((scheme) => ({
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  })),
]);

app.commandLine.appendSwitch("ignore-certificate-errors");
