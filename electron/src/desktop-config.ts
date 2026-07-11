import { app, protocol } from "electron";
import os from "node:os";
import path from "node:path";

declare const __RUNWEAVE_DESKTOP_CHANNEL__: "stable" | "beta";
declare const __RUNWEAVE_DESKTOP_SOURCE_REVISION__: string;

export const desktopChannel = __RUNWEAVE_DESKTOP_CHANNEL__;
export const desktopSourceRevision = __RUNWEAVE_DESKTOP_SOURCE_REVISION__;
export const isBetaChannel = desktopChannel === "beta";
export const BETA_DESKTOP_CDP_PORT = 9335;
export const betaDesktopCdpEndpoint = isBetaChannel
  ? `http://127.0.0.1:${BETA_DESKTOP_CDP_PORT}`
  : null;

if (isBetaChannel) {
  app.setName("Runweave Beta");
  app.setPath("userData", path.join(app.getPath("appData"), "Runweave Beta"));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    String(BETA_DESKTOP_CDP_PORT),
  );
  process.env.RUNWEAVE_DESKTOP_CHANNEL = "beta";
  process.env.BROWSER_PROFILE_DIR = path.join(
    app.getPath("userData"),
    "browser-profile",
  );
  process.env.AUTH_STORE_FILE = path.join(
    process.env.BROWSER_PROFILE_DIR,
    "auth-store.json",
  );
  process.env.RUNWEAVE_CONFIG_FILE = path.join(
    app.getPath("userData"),
    "cli",
    "config.json",
  );
  delete process.env.RUNWEAVE_ACCESS_TOKEN;
  process.env.RUNWEAVE_APP_SERVER_HOME = path.join(
    os.homedir(),
    ".runweave",
    "app-server-beta",
  );
  process.env.RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR = path.join(
    process.env.RUNWEAVE_APP_SERVER_HOME,
    "cloud-sync",
  );
}

export const isDev = !app.isPackaged;
process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND = isDev ? "false" : "true";

export const DEV_SERVER_URL =
  process.env.RUNWEAVE_DEV_URL ??
  process.env.BROWSER_VIEWER_DEV_URL ??
  "http://127.0.0.1:5173";

export const DEV_RENDERER_DIST = path.join(__dirname, "../../frontend/dist");
export const PRELOAD_PATH = path.join(__dirname, "preload.cjs");
export const DEV_DOCK_ICON_PATH = path.join(
  __dirname,
  "../resources/icons/icon-preview.png",
);

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
