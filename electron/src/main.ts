import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  protocol,
  net,
  nativeImage,
} from "electron";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import pidusage from "pidusage";
import path from "node:path";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
  SystemMonitorSnapshot,
  TerminalBrowserCdpProxyInfo,
} from "@runweave/shared";
import {
  BROWSER_PROFILE_LOCK_FILE_NAME,
  getBrowserProfileLockFile,
  resolveDefaultBrowserProfileDir,
  resolveBrowserProfileRootDir,
  resolveBrowserProfileDir,
  resolveLegacyBrowserProfileRootDir,
} from "@runweave/shared/src/browser-profile-node";
import { resolveProtocolFilePath } from "./protocol-path.js";
import {
  startCdpProxy,
  type CdpProxyRuntime,
} from "./terminal-browser-cdp-proxy.js";
import {
  resolveCdpProxyPort,
  findAvailableCdpProxyPort,
  CDP_PROXY_HOST,
} from "./terminal-browser-cdp-proxy-port.js";
import {
  startPackagedBackend,
  type PackagedBackendRuntimeIncidentEvent,
  type PackagedBackendRuntime,
} from "./backend-runtime.js";
import { DesktopIncidentLogger } from "./desktop-incident-logger.js";
import {
  resolveActiveRuntimeRelease,
  resolveRuntimeRoot,
  type RuntimeRelease,
} from "./runtime-release.js";
import { checkAppServerAvailability } from "./app-server-cli.js";
import { createTray } from "./tray.js";
import { initAutoUpdater, checkForUpdates } from "./updater.js";
import { getIsQuitting, setIsQuitting } from "./app-state.js";
import { shouldEnableAutoUpdates } from "./updater-config.js";
import {
  buildRuntimeStatsSnapshot,
  type ElectronProcessMetric,
} from "./runtime-monitor.js";
import { buildSystemMonitorSnapshot } from "./system-monitor.js";
import {
  createAvailablePackagedBackendState,
  createUnavailablePackagedBackendStateFromError,
  createUnavailablePackagedBackendStateFromExit,
} from "./packaged-backend-state.js";
import { buildApplicationMenuTemplate } from "./application-menu.js";
import { shouldAutoOpenWindowDevtools } from "./window-devtools.js";
import {
  closeTerminalBrowsersForWindow,
  registerTerminalBrowserHandlers,
  getTerminalBrowserEntryByTargetId,
  getTerminalBrowserCdpTargets,
} from "./terminal-browser-view.js";
import { installHooksIfNeeded } from "./hooks/hook-installer.js";

declare const __RUNWEAVE_DESKTOP_CHANNEL__: "stable" | "beta";
declare const __RUNWEAVE_DESKTOP_SOURCE_REVISION__: string;

const desktopChannel = __RUNWEAVE_DESKTOP_CHANNEL__;
const desktopSourceRevision = __RUNWEAVE_DESKTOP_SOURCE_REVISION__;
const isBetaChannel = desktopChannel === "beta";
const BETA_DESKTOP_CDP_PORT = 9335;
const betaDesktopCdpEndpoint = isBetaChannel
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

const isDev = !app.isPackaged;
process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND = isDev ? "false" : "true";

const DEV_SERVER_URL =
  process.env.RUNWEAVE_DEV_URL ??
  process.env.BROWSER_VIEWER_DEV_URL ??
  "http://127.0.0.1:5173";

const DEV_RENDERER_DIST = path.join(__dirname, "../../frontend/dist");
const PRELOAD_PATH = path.join(__dirname, "preload.cjs");
const DEV_DOCK_ICON_PATH = path.join(
  __dirname,
  "../resources/icons/icon-preview.png",
);

const CUSTOM_PROTOCOL = "runweave";
const LEGACY_CUSTOM_PROTOCOL = "browser-viewer";

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

function registerCustomProtocol(getFrontendDistDir: () => string) {
  const handleAppProtocol = (request: Request) => {
    const resolved = resolveProtocolFilePath(request.url, getFrontendDistDir());

    if (resolved.status === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(`file://${resolved.filePath}`);
  };

  protocol.handle(CUSTOM_PROTOCOL, handleAppProtocol);
  protocol.handle(LEGACY_CUSTOM_PROTOCOL, handleAppProtocol);
}

function registerOpenExternalHandler(): void {
  ipcMain.handle("viewer:open-external", async (_event, url: string) => {
    if (typeof url !== "string") {
      return;
    }

    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        return;
      }
      await shell.openExternal(url);
    } catch {
      return;
    }
  });
}

function registerRuntimeStatsHandler(
  getPackagedBackendRuntime: () => PackagedBackendRuntime | null,
): void {
  ipcMain.handle(
    "viewer:get-runtime-stats",
    async (): Promise<RuntimeStatsSnapshot> => {
      const packagedBackendRuntime = getPackagedBackendRuntime();
      const backendPid =
        typeof packagedBackendRuntime?.child.pid === "number"
          ? packagedBackendRuntime.child.pid
          : null;

      let backendUsage: { cpu: number; memory: number } | null = null;
      if (backendPid !== null) {
        try {
          const usage = await pidusage(backendPid);
          backendUsage = {
            cpu: usage.cpu,
            memory: usage.memory,
          };
        } catch {
          backendUsage = null;
        }
      }

      return buildRuntimeStatsSnapshot({
        sampledAt: Date.now(),
        processMetrics: app.getAppMetrics() as ElectronProcessMetric[],
        backendPid,
        backendUsage,
      });
    },
  );
}

function registerSystemMonitorHandler(
  getPackagedBackendRuntime: () => PackagedBackendRuntime | null,
): void {
  ipcMain.handle(
    "system-monitor:get",
    async (event): Promise<SystemMonitorSnapshot> => {
      if (!isSystemMonitorSenderAllowed(event.senderFrame?.url ?? "")) {
        throw new Error("System Monitor is only available from the local app.");
      }

      const electronProcessIds = app
        .getAppMetrics()
        .map((metric) => metric.pid)
        .filter((pid): pid is number => typeof pid === "number");
      const backendPid = getPackagedBackendRuntime()?.child.pid;
      const currentProcessIds =
        typeof backendPid === "number"
          ? [...electronProcessIds, backendPid]
          : electronProcessIds;

      return await buildSystemMonitorSnapshot({ currentProcessIds });
    },
  );
}

function isSystemMonitorSenderAllowed(senderUrl: string): boolean {
  try {
    const parsed = new URL(senderUrl);
    if (isDev) {
      const devUrl = new URL(DEV_SERVER_URL);
      if (parsed.origin !== devUrl.origin) {
        return false;
      }
    } else if (
      parsed.protocol !== `${CUSTOM_PROTOCOL}:` &&
      parsed.protocol !== `${LEGACY_CUSTOM_PROTOCOL}:`
    ) {
      return false;
    }

    return parsed.pathname === "/system-monitor";
  } catch {
    return false;
  }
}

function createWindow(options?: {
  hideOnClose?: boolean;
  initialPath?: string;
  onReadyToShow?: (win: BrowserWindow) => void;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: "default",
    show: false,
    title: isBetaChannel ? "Runweave Beta" : "Runweave",
  });

  win.once("ready-to-show", () => {
    win.show();
    options?.onReadyToShow?.(win);
  });
  win.once("closed", () => {
    closeTerminalBrowsersForWindow(win.id);
  });

  if (isDev) {
    win.loadURL(`${DEV_SERVER_URL}${options?.initialPath ?? ""}`);
    if (shouldAutoOpenWindowDevtools({ isDev })) {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadURL(`${CUSTOM_PROTOCOL}://app/index.html`);
    if (options?.initialPath) {
      win.webContents.once("did-finish-load", () => {
        navigateWindowToPath(win, options.initialPath ?? "/");
      });
    }
  }

  setupSessionIntercept(win);

  if (options?.hideOnClose) {
    win.on("close", (event) => {
      if (!getIsQuitting()) {
        event.preventDefault();
        win.hide();
      }
    });
  }

  return win;
}

function navigateWindowToPath(win: BrowserWindow, routePath: string): void {
  if (win.isDestroyed()) {
    return;
  }

  if (isDev) {
    void win.loadURL(`${DEV_SERVER_URL}${routePath}`);
    return;
  }

  const serializedPath = JSON.stringify(routePath);
  void win.webContents
    .executeJavaScript(
      `window.history.pushState(null, "", ${serializedPath}); window.dispatchEvent(new PopStateEvent("popstate"));`,
    )
    .catch(() => {
      if (win.isDestroyed()) {
        return;
      }
      void win.loadURL(`${CUSTOM_PROTOCOL}://app/index.html`).then(() => {
        navigateWindowToPath(win, routePath);
      });
    });
}

function setApplicationIcon(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const icon = nativeImage.createFromPath(DEV_DOCK_ICON_PATH);
  if (icon.isEmpty()) {
    return;
  }

  app.dock.setIcon(icon);
}

function isBackendRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    const p = parsed.pathname;
    return (
      p.startsWith("/api/") ||
      p.startsWith("/ws/") ||
      p.startsWith("/ws?") ||
      p === "/health"
    );
  } catch {
    return false;
  }
}

function hasResponseHeader(
  headers: Record<string, string[]>,
  headerName: string,
): boolean {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.keys(headers).some(
    (name) => name.toLowerCase() === normalizedHeaderName,
  );
}

function setupSessionIntercept(win: BrowserWindow) {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = { ...details.responseHeaders };

    delete headers["content-security-policy"];
    delete headers["Content-Security-Policy"];

    if (
      isBackendRequest(details.url) &&
      !hasResponseHeader(headers, "Access-Control-Allow-Origin")
    ) {
      headers["Access-Control-Allow-Origin"] = ["*"];
      headers["Access-Control-Allow-Methods"] = [
        "GET, POST, DELETE, PATCH, PUT, OPTIONS",
      ];
      headers["Access-Control-Allow-Headers"] = [
        "Content-Type, Authorization, X-Auth-Client, X-Connection-Id",
      ];
    }

    callback({ responseHeaders: headers });
  });
}

app.commandLine.appendSwitch("ignore-certificate-errors");

let packagedBackendRuntime: PackagedBackendRuntime | null = null;
let cdpProxyRuntime: CdpProxyRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let activeRuntimeRelease: RuntimeRelease | null = null;
let packagedBackendState: PackagedBackendConnectionState = {
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
};
let packagedBackendRestartPromise: Promise<PackagedBackendConnectionState> | null =
  null;
const expectedPackagedBackendExits = new WeakSet<object>();
let packagedBackendsStoppedForQuit = false;
let stoppingPackagedBackendsForQuit = false;
let desktopIncidentLogger: DesktopIncidentLogger | null = null;
let appServerUnavailableDialogShown = false;

function writeBetaDesktopStatus(stoppedAt: string | null = null): void {
  if (!isBetaChannel) {
    return;
  }

  try {
    const userDataPath = app.getPath("userData");
    const statusPath = path.join(userDataPath, "beta-desktop-status.json");
    const tempPath = `${statusPath}.tmp`;
    const backendPid = packagedBackendRuntime?.child.pid ?? null;
    const appPath = app.isPackaged
      ? path.resolve(path.dirname(process.execPath), "../..")
      : null;
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(
      tempPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          channel: desktopChannel,
          sourceRevision: desktopSourceRevision,
          app: {
            path: appPath,
            pid: process.pid,
            userDataPath,
            version: app.getVersion(),
          },
          backend: {
            available: stoppedAt ? false : packagedBackendState.available,
            baseUrl: packagedBackendState.backendUrl || null,
            pid: stoppedAt ? null : backendPid,
            profileDir: resolvePackagedBackendProfileDir(),
            runtimeReleaseId: packagedBackendState.runtimeReleaseId,
            runtimeSource: packagedBackendState.runtimeSource,
          },
          cli: {
            configPath: process.env.RUNWEAVE_CONFIG_FILE ?? null,
          },
          cdp: {
            endpoint: stoppedAt ? null : betaDesktopCdpEndpoint,
            pid: stoppedAt ? null : process.pid,
          },
          stoppedAt,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    renameSync(tempPath, statusPath);
  } catch (error) {
    console.warn("[electron] failed to write Beta desktop status", error);
  }
}

interface PackagedBackendAuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  createdAt: string;
}

interface BetaPersistedAuthRecord {
  username: string;
  password: string;
  jwtSecret: string;
  updatedAt: string;
  refreshSessions?: unknown[];
}

interface BetaAuthStoreData {
  auth: BetaPersistedAuthRecord | null;
}

interface BetaCliAuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const PACKAGED_BACKEND_AUTH_FILE_NAME = "backend-auth.json";

function resolvePackagedBackendProfileDir(): string {
  return resolveBrowserProfileDir(process.env, os.homedir(), "/");
}

function resolvePackagedBackendAuthFile(): string {
  return path.join(app.getPath("userData"), PACKAGED_BACKEND_AUTH_FILE_NAME);
}

function resolveBetaAuthStoreFile(): string {
  return path.join(resolvePackagedBackendProfileDir(), "auth-store.json");
}

function createRandomCredential(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function isPackagedBackendAuthConfig(
  value: unknown,
): value is PackagedBackendAuthConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    record.username.trim().length > 0 &&
    typeof record.password === "string" &&
    record.password.trim().length > 0 &&
    typeof record.jwtSecret === "string" &&
    record.jwtSecret.trim().length > 0 &&
    typeof record.createdAt === "string" &&
    record.createdAt.trim().length > 0
  );
}

function writePackagedBackendAuthConfig(
  filePath: string,
  config: PackagedBackendAuthConfig,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission tightening; non-fatal on filesystems that
    // do not support POSIX modes.
  }
}

function loadOrCreatePackagedBackendAuthConfig(): PackagedBackendAuthConfig {
  const filePath = resolvePackagedBackendAuthFile();
  if (existsSync(filePath)) {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isPackagedBackendAuthConfig(parsed)) {
      throw new Error(
        `[electron] invalid packaged backend auth file: ${filePath}`,
      );
    }
    return parsed;
  }

  const config: PackagedBackendAuthConfig = {
    username: `runweave-${createRandomCredential(9)}`,
    password: createRandomCredential(),
    jwtSecret: createRandomCredential(),
    createdAt: new Date().toISOString(),
  };
  writePackagedBackendAuthConfig(filePath, config);
  return config;
}

function isBetaPersistedAuthRecord(
  value: unknown,
): value is BetaPersistedAuthRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    record.username.trim().length > 0 &&
    typeof record.password === "string" &&
    record.password.trim().length > 0 &&
    typeof record.jwtSecret === "string" &&
    record.jwtSecret.trim().length > 0 &&
    typeof record.updatedAt === "string" &&
    record.updatedAt.trim().length > 0
  );
}

function readBetaAuthStore(): {
  data: BetaAuthStoreData;
  record: BetaPersistedAuthRecord;
} | null {
  const filePath = resolveBetaAuthStoreFile();
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8")) as BetaAuthStoreData;
    if (!isBetaPersistedAuthRecord(data.auth)) {
      return null;
    }
    return {
      data,
      record: {
        ...data.auth,
        refreshSessions: Array.isArray(data.auth.refreshSessions)
          ? data.auth.refreshSessions
          : [],
      },
    };
  } catch {
    return null;
  }
}

function toPackagedBackendAuthConfig(
  record: BetaPersistedAuthRecord,
): PackagedBackendAuthConfig {
  return {
    username: record.username,
    password: record.password,
    jwtSecret: record.jwtSecret,
    createdAt: record.updatedAt,
  };
}

function hasMatchingAuthCredentials(
  left: Pick<PackagedBackendAuthConfig, "username" | "password" | "jwtSecret">,
  right: Pick<PackagedBackendAuthConfig, "username" | "password" | "jwtSecret">,
): boolean {
  return (
    left.username === right.username &&
    left.password === right.password &&
    left.jwtSecret === right.jwtSecret
  );
}

function writeMigratedBetaAuthStore(
  data: BetaAuthStoreData,
  record: BetaPersistedAuthRecord,
  bootstrap: PackagedBackendAuthConfig,
): void {
  const filePath = resolveBetaAuthStoreFile();
  const tempPath = `${filePath}.tmp`;
  writeFileSync(
    tempPath,
    `${JSON.stringify(
      {
        ...data,
        auth: {
          ...record,
          username: bootstrap.username,
          password: bootstrap.password,
          jwtSecret: bootstrap.jwtSecret,
          updatedAt: new Date().toISOString(),
          refreshSessions: [],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, filePath);
}

function resolveBetaPackagedBackendAuthConfig(): PackagedBackendAuthConfig {
  const persisted = readBetaAuthStore();
  if (!persisted) {
    return loadOrCreatePackagedBackendAuthConfig();
  }

  const bootstrapPath = resolvePackagedBackendAuthFile();
  if (!existsSync(bootstrapPath)) {
    return toPackagedBackendAuthConfig(persisted.record);
  }
  const bootstrap = loadOrCreatePackagedBackendAuthConfig();
  if (hasMatchingAuthCredentials(persisted.record, bootstrap)) {
    return toPackagedBackendAuthConfig(persisted.record);
  }

  const persistedUpdatedAt = Date.parse(persisted.record.updatedAt);
  const bootstrapCreatedAt = Date.parse(bootstrap.createdAt);
  if (
    Number.isFinite(persistedUpdatedAt) &&
    Number.isFinite(bootstrapCreatedAt) &&
    persistedUpdatedAt <= bootstrapCreatedAt
  ) {
    writeMigratedBetaAuthStore(persisted.data, persisted.record, bootstrap);
    return bootstrap;
  }

  return toPackagedBackendAuthConfig(persisted.record);
}

function readBetaCliRefreshToken(): string | null {
  const configPath = process.env.RUNWEAVE_CONFIG_FILE;
  if (!configPath || !existsSync(configPath)) {
    return null;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profiles?: { beta?: { refreshToken?: unknown } };
    };
    const refreshToken = config.profiles?.beta?.refreshToken;
    return typeof refreshToken === "string" && refreshToken.trim()
      ? refreshToken
      : null;
  } catch {
    return null;
  }
}

async function requestBetaCliAuth(
  baseUrl: string,
  authConfig: PackagedBackendAuthConfig,
): Promise<BetaCliAuthResponse> {
  const refreshToken = readBetaCliRefreshToken();
  if (refreshToken) {
    const refreshResponse = await net.fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-client": "electron",
      },
      body: JSON.stringify({ refreshToken }),
    });
    if (refreshResponse.ok) {
      return (await refreshResponse.json()) as BetaCliAuthResponse;
    }
  }

  const loginResponse = await net.fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-client": "electron",
    },
    body: JSON.stringify({
      username: authConfig.username,
      password: authConfig.password,
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(
      `Beta CLI login failed with status ${loginResponse.status}`,
    );
  }
  return (await loginResponse.json()) as BetaCliAuthResponse;
}

async function ensureBetaCliProfile(baseUrl: string): Promise<void> {
  if (!isBetaChannel) {
    return;
  }
  const configPath = process.env.RUNWEAVE_CONFIG_FILE;
  if (!configPath) {
    throw new Error("Beta CLI config path is unavailable");
  }
  const auth = await requestBetaCliAuth(
    baseUrl,
    resolveBetaPackagedBackendAuthConfig(),
  );
  if (!auth.accessToken || !auth.refreshToken || !auth.expiresIn) {
    throw new Error("Beta CLI login returned an incomplete auth response");
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tempConfigPath = `${configPath}.tmp`;
  writeFileSync(
    tempConfigPath,
    `${JSON.stringify(
      {
        activeProfile: "beta",
        profiles: {
          beta: {
            baseUrl,
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            expiresAt: new Date(
              Date.now() + auth.expiresIn * 1000,
            ).toISOString(),
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(tempConfigPath, 0o600);
  renameSync(tempConfigPath, configPath);
  rmSync(resolvePackagedBackendAuthFile(), { force: true });
}

function hasCompleteAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AUTH_USERNAME?.trim() &&
    env.AUTH_PASSWORD?.trim() &&
    env.AUTH_JWT_SECRET?.trim(),
  );
}

function resolvePackagedBackendAuthEnv(
  env: NodeJS.ProcessEnv,
): Pick<
  NodeJS.ProcessEnv,
  "AUTH_USERNAME" | "AUTH_PASSWORD" | "AUTH_JWT_SECRET"
> {
  if (!isBetaChannel && hasCompleteAuthEnv(env)) {
    return {
      AUTH_USERNAME: env.AUTH_USERNAME,
      AUTH_PASSWORD: env.AUTH_PASSWORD,
      AUTH_JWT_SECRET: env.AUTH_JWT_SECRET,
    };
  }

  const config = isBetaChannel
    ? resolveBetaPackagedBackendAuthConfig()
    : loadOrCreatePackagedBackendAuthConfig();
  return {
    AUTH_USERNAME: config.username,
    AUTH_PASSWORD: config.password,
    AUTH_JWT_SECRET: config.jwtSecret,
  };
}

function buildPackagedBackendBaseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(!isDev ? resolvePackagedBackendAuthEnv(process.env) : {}),
    BROWSER_PROFILE_DIR: resolvePackagedBackendProfileDir(),
  };
}

function logDesktopIncident(event: PackagedBackendRuntimeIncidentEvent): void {
  if (!desktopIncidentLogger) {
    return;
  }

  const level = event.level ?? "info";
  if (level === "error") {
    desktopIncidentLogger.error(event.event, event.details);
  } else if (level === "warn") {
    desktopIncidentLogger.warn(event.event, event.details);
  } else {
    desktopIncidentLogger.info(event.event, event.details);
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function collectBackendLockSnapshots(): Array<Record<string, unknown>> {
  const snapshots: Array<Record<string, unknown>> = [];
  const profileRoots = [
    resolveBrowserProfileRootDir(os.homedir()),
    resolveLegacyBrowserProfileRootDir(os.homedir()),
  ];
  for (const profileRoot of profileRoots) {
    if (!existsSync(profileRoot)) {
      continue;
    }
    for (const entry of readdirSync(profileRoot).slice(0, 50)) {
      const profileDir = path.join(profileRoot, entry);
      const lockFile = getBrowserProfileLockFile(profileDir);
      if (!existsSync(lockFile)) {
        continue;
      }
      snapshots.push({
        profileRoot,
        profileDir,
        lockFile,
        owner: readJsonFile(lockFile),
      });
    }
  }
  return snapshots;
}

function buildDesktopDiagnosticSnapshot(): Record<string, unknown> {
  const runtimeRoot = getPackagedRuntimeRoot();
  return {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    isDev,
    pid: process.pid,
    cwd: process.cwd(),
    userDataPath: app.getPath("userData"),
    logsPath: app.getPath("logs"),
    resourcesPath: process.resourcesPath,
    backendState: packagedBackendState,
    packagedBackendPid: packagedBackendRuntime?.child.pid ?? null,
    packagedBackendExitCode: packagedBackendRuntime?.child.exitCode ?? null,
    packagedBackendSignalCode: packagedBackendRuntime?.child.signalCode ?? null,
    cdpProxyEndpoint: cdpProxyRuntime?.endpoint ?? null,
    runtimeRoot,
    currentRuntime: runtimeRoot
      ? readJsonFile(path.join(runtimeRoot, "current.json"))
      : null,
    lastKnownGoodRuntime: runtimeRoot
      ? readJsonFile(path.join(runtimeRoot, "last-known-good.json"))
      : null,
    defaultBackendProfileDir: resolveDefaultBrowserProfileDir(
      process.cwd(),
      os.homedir(),
    ),
    packagedBackendProfileDir: resolvePackagedBackendProfileDir(),
    backendProfileLockFileName: BROWSER_PROFILE_LOCK_FILE_NAME,
    backendLocks: collectBackendLockSnapshots(),
  };
}

function initializeDesktopIncidentLogger(): void {
  try {
    desktopIncidentLogger = new DesktopIncidentLogger({
      appName: app.getName(),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      logsPath: app.getPath("logs"),
      userDataPath: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
    });
    desktopIncidentLogger.recordLaunch();
    desktopIncidentLogger.recordNewCrashReports();
  } catch (error) {
    desktopIncidentLogger = null;
    console.warn(
      "[electron] failed to initialize desktop incident logger",
      error,
    );
  }
}

function exportDesktopDiagnostics(): void {
  if (!desktopIncidentLogger) {
    dialog.showErrorBox(
      "Export Desktop Diagnostics Failed",
      "Desktop incident logger is not available.",
    );
    return;
  }

  try {
    const result = desktopIncidentLogger.exportDiagnosticPackage({
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    shell.showItemInFolder(result.summaryFile);
    void dialog.showMessageBox({
      type: "info",
      title: "Desktop Diagnostics Exported",
      message: "Desktop diagnostics package exported.",
      detail: result.directory,
    });
  } catch (error) {
    desktopIncidentLogger.error("desktop.diagnostics.exportFailed", { error });
    dialog.showErrorBox("Export Desktop Diagnostics Failed", String(error));
  }
}

function getPackagedRuntimeRoot(): string | null {
  if (isDev) {
    return null;
  }

  return resolveRuntimeRoot(app.getPath("userData"));
}

function refreshActiveRuntimeRelease(): RuntimeRelease {
  activeRuntimeRelease = resolveActiveRuntimeRelease({
    runtimeRoot: getPackagedRuntimeRoot(),
    resourcesPath: process.resourcesPath,
    shellVersion: app.getVersion(),
  });
  return activeRuntimeRelease;
}

function getActiveFrontendDistDir(): string {
  if (isDev) {
    return DEV_RENDERER_DIST;
  }

  return (activeRuntimeRelease ?? refreshActiveRuntimeRelease())
    .frontendDistDir;
}

function broadcastPackagedBackendState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(
        "viewer:packaged-backend-state",
        packagedBackendState,
      );
    }
  }
}

function setPackagedBackendState(
  state: PackagedBackendConnectionState,
): PackagedBackendConnectionState {
  packagedBackendState = state;
  process.env.RUNWEAVE_BACKEND_URL = state.backendUrl;
  writeBetaDesktopStatus();
  broadcastPackagedBackendState();
  return packagedBackendState;
}

function attachPackagedBackendExitHandler(
  runtime: PackagedBackendRuntime,
): void {
  runtime.child.once("exit", (code, signal) => {
    const expectedExit = expectedPackagedBackendExits.has(runtime.child);
    expectedPackagedBackendExits.delete(runtime.child);

    if (packagedBackendRuntime?.child === runtime.child) {
      packagedBackendRuntime = null;
    }

    if (getIsQuitting() || expectedExit) {
      return;
    }

    console.error("[electron] packaged backend exited unexpectedly", {
      code,
      signal,
    });
    desktopIncidentLogger?.error("packagedBackend.exit.unexpected", {
      code,
      signal,
      backendUrl: runtime.backendUrl,
      pid: runtime.child.pid ?? null,
      outputTail: runtime.getOutputTail(),
      runtimeRelease: runtime.runtimeRelease,
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    setPackagedBackendState(
      createUnavailablePackagedBackendStateFromExit(runtime.backendUrl, {
        code,
        signal,
      }),
    );

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function stopPackagedBackendRuntimeForRestart(): Promise<void> {
  if (!packagedBackendRuntime) {
    return;
  }

  expectedPackagedBackendExits.add(packagedBackendRuntime.child);
  const runtime = packagedBackendRuntime;
  packagedBackendRuntime = null;
  await runtime.stop();
}

async function checkAppServerForPackagedBackend(
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof checkAppServerAvailability>>> {
  return await checkAndNotifyAppServerAvailability(env);
}

async function checkAndNotifyAppServerAvailability(
  env: NodeJS.ProcessEnv,
  parentWindow?: BrowserWindow | null,
): Promise<Awaited<ReturnType<typeof checkAppServerAvailability>>> {
  const connection = await checkAppServerAvailability({
    env,
    logger: desktopIncidentLogger ?? undefined,
  });
  if (connection) {
    appServerUnavailableDialogShown = false;
    return connection;
  }

  if (!appServerUnavailableDialogShown) {
    showAppServerUnavailableDialog(parentWindow);
  }

  return null;
}

function showAppServerUnavailableDialog(
  parentWindow?: BrowserWindow | null,
): void {
  appServerUnavailableDialogShown = true;
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["OK"],
    title: "App Server",
    message: "App Server 没有启动",
    detail: "Runweave 不会自动安装、启动或重启 App Server。",
  };
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.show();
    parentWindow.focus();
    setTimeout(() => {
      if (!parentWindow.isDestroyed()) {
        void dialog.showMessageBox(parentWindow, options);
      }
    }, 100);
    return;
  }
  void dialog.showMessageBox(options);
}

async function startPackagedBackendRuntime(): Promise<PackagedBackendConnectionState> {
  try {
    desktopIncidentLogger?.info("packagedBackend.start.requested", {
      runtimeRoot: getPackagedRuntimeRoot(),
      resourcesPath: process.resourcesPath,
      shellVersion: app.getVersion(),
      profileDir: resolvePackagedBackendProfileDir(),
    });
    const runtime = await startPackagedBackend({
      baseEnv: buildPackagedBackendBaseEnv(),
      ensureAppServer: async (_release, env) =>
        await checkAppServerForPackagedBackend(env),
      onIncidentEvent: logDesktopIncident,
      runtimeRoot: getPackagedRuntimeRoot(),
      resourcesPath: process.resourcesPath,
      shellVersion: app.getVersion(),
    });

    try {
      await ensureBetaCliProfile(runtime.backendUrl);
    } catch (error) {
      await runtime.stop();
      throw error;
    }

    packagedBackendRuntime = runtime;
    activeRuntimeRelease = runtime.runtimeRelease;
    attachPackagedBackendExitHandler(runtime);
    desktopIncidentLogger?.info("packagedBackend.start.succeeded", {
      backendUrl: runtime.backendUrl,
      pid: runtime.child.pid ?? null,
      runtimeRelease: runtime.runtimeRelease,
      startupWarning: runtime.startupWarning,
    });
    return setPackagedBackendState(
      createAvailablePackagedBackendState(runtime.backendUrl, {
        runtimeSource: runtime.runtimeRelease.source,
        runtimeReleaseId: runtime.runtimeRelease.releaseId,
        statusMessage: runtime.startupWarning,
      }),
    );
  } catch (error) {
    console.error("[electron] packaged backend unavailable", error);
    desktopIncidentLogger?.error("packagedBackend.start.failed", {
      error,
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    return setPackagedBackendState(
      createUnavailablePackagedBackendStateFromError(
        packagedBackendState.backendUrl,
        error,
      ),
    );
  }
}

async function restartPackagedBackendRuntime(): Promise<PackagedBackendConnectionState> {
  if (packagedBackendRestartPromise) {
    return packagedBackendRestartPromise;
  }

  packagedBackendRestartPromise = (async () => {
    await stopPackagedBackendRuntimeForRestart();
    return await startPackagedBackendRuntime();
  })();

  try {
    return await packagedBackendRestartPromise;
  } finally {
    packagedBackendRestartPromise = null;
  }
}

async function reloadLocalRuntime(): Promise<PackagedBackendConnectionState> {
  if (isDev) {
    return packagedBackendState;
  }

  const state = await restartPackagedBackendRuntime();
  if (!state.available) {
    dialog.showErrorBox(
      "Reload Local Runtime Failed",
      state.statusMessage ?? "Local runtime reload failed.",
    );
    return state;
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  }

  if (state.statusMessage) {
    dialog.showMessageBox({
      type: "warning",
      title: "Local Runtime Rolled Back",
      message: state.statusMessage,
    });
  }

  return state;
}

function registerPackagedBackendHandlers(): void {
  ipcMain.handle(
    "viewer:get-packaged-backend-state",
    async (): Promise<PackagedBackendConnectionState> => {
      return packagedBackendState;
    },
  );

  ipcMain.handle(
    "viewer:restart-packaged-backend",
    async (): Promise<PackagedBackendConnectionState> => {
      if (isDev) {
        return packagedBackendState;
      }

      return await restartPackagedBackendRuntime();
    },
  );

  ipcMain.handle(
    "viewer:reload-runtime",
    async (): Promise<PackagedBackendConnectionState> => {
      return await reloadLocalRuntime();
    },
  );

  ipcMain.handle("viewer:check-app-server", async (event): Promise<boolean> => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return (
      (await checkAndNotifyAppServerAvailability(process.env, parentWindow)) !==
      null
    );
  });
}

function registerCdpProxyHandlers(): void {
  ipcMain.handle(
    "terminal-browser:get-cdp-proxy-info",
    (_event, tabId: string): TerminalBrowserCdpProxyInfo => {
      const proxy = cdpProxyRuntime;
      const targets = getTerminalBrowserCdpTargets();
      const match = targets.find((t) => t.key.endsWith(`:${tabId}`));
      const found = match
        ? getTerminalBrowserEntryByTargetId(match.targetId)
        : null;

      if (!proxy) {
        return {
          available: false,
          endpoint: null,
          webSocketEndpoint: null,
          port: null,
          host: "127.0.0.1",
          tabId,
          targetId: null,
          browserGroupId: null,
          url: "",
          title: "",
          attached: false,
          devtoolsOpen: false,
          env: null,
          error: "CDP proxy is not running",
        };
      }

      const webSocketEndpoint = match?.browserGroupId
        ? [
            `ws://${proxy.host}:${proxy.port}`,
            "/devtools/browser/runweave-terminal-browser",
            `?groupId=${encodeURIComponent(match.browserGroupId)}`,
          ].join("")
        : null;

      return {
        available: true,
        endpoint: proxy.endpoint,
        webSocketEndpoint,
        port: proxy.port,
        host: "127.0.0.1",
        tabId,
        targetId: match?.targetId ?? null,
        browserGroupId: match?.browserGroupId ?? null,
        url: match?.url ?? "",
        title: match?.title ?? "",
        attached: found?.entry.cdpProxyAttached ?? false,
        devtoolsOpen: found?.entry.devtoolsOpen ?? false,
        env: {
          PLAYWRIGHT_MCP_CDP_ENDPOINT: webSocketEndpoint ?? proxy.endpoint,
        },
      };
    },
  );
}

process.on("uncaughtExceptionMonitor", (error) => {
  desktopIncidentLogger?.error("desktop.process.uncaughtException", { error });
  console.error("[electron] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  desktopIncidentLogger?.error("desktop.process.unhandledRejection", {
    reason:
      reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : String(reason),
  });
  console.error("[electron] unhandled rejection", reason);
});

app.on("render-process-gone", (_event, webContents, details) => {
  desktopIncidentLogger?.error("desktop.renderProcess.gone", {
    webContentsId: webContents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on("child-process-gone", (_event, details) => {
  desktopIncidentLogger?.error("desktop.childProcess.gone", details);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      initializeDesktopIncidentLogger();
      writeBetaDesktopStatus();
      setApplicationIcon();
      registerOpenExternalHandler();
      registerPackagedBackendHandlers();
      registerRuntimeStatsHandler(() => packagedBackendRuntime);
      registerSystemMonitorHandler(() => packagedBackendRuntime);
      registerTerminalBrowserHandlers();
      registerCdpProxyHandlers();
      if (!isBetaChannel) {
        await installHooksIfNeeded({
          resourcesDir: path.join(__dirname, "..", "resources"),
        });
      }

      const portConfig = resolveCdpProxyPort(process.env);
      const cdpProxyPort = portConfig.strict
        ? portConfig.port
        : await findAvailableCdpProxyPort(portConfig.port);
      cdpProxyRuntime = await startCdpProxy({
        host: CDP_PROXY_HOST,
        port: cdpProxyPort,
      });
      process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = cdpProxyRuntime.endpoint;
      writeBetaDesktopStatus();

      if (isDev) {
        // In dev mode, backend is an independent process started before Electron.
        // Notify it of the CDP proxy endpoint so PTY terminals inherit the env var.
        const backendUrl =
          process.env.RUNWEAVE_BACKEND_URL ??
          process.env.BROWSER_VIEWER_BACKEND_URL;
        if (backendUrl) {
          try {
            const resp = await net.fetch(
              `${backendUrl}/internal/cdp-endpoint`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ endpoint: cdpProxyRuntime.endpoint }),
              },
            );
            if (!resp.ok) {
              console.warn(
                "[electron] failed to propagate CDP endpoint to backend",
                {
                  status: resp.status,
                },
              );
            }
          } catch (error) {
            console.warn(
              "[electron] failed to propagate CDP endpoint to backend",
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }

      if (!isDev) {
        refreshActiveRuntimeRelease();
        registerCustomProtocol(getActiveFrontendDistDir);
        await startPackagedBackendRuntime();
      }

      const openNewWindow = (): BrowserWindow => {
        return createWindow();
      };

      const openSystemMonitor = (): void => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          mainWindow = createWindow({
            hideOnClose: true,
            initialPath: "/system-monitor",
          });
          return;
        }

        mainWindow.show();
        mainWindow.focus();
        navigateWindowToPath(mainWindow, "/system-monitor");
      };

      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          buildApplicationMenuTemplate({
            platform: process.platform,
            onExportDesktopDiagnostics: exportDesktopDiagnostics,
            onNewWindow: openNewWindow,
            onOpenSystemMonitor: openSystemMonitor,
            onReloadLocalRuntime: reloadLocalRuntime,
          }),
        ),
      );

      mainWindow = createWindow({
        hideOnClose: true,
        onReadyToShow: (win) => {
          void checkAndNotifyAppServerAvailability(process.env, win);
        },
      });

      createTray(mainWindow, {
        enableUpdates: !isBetaChannel,
        onOpenSystemMonitor: openSystemMonitor,
        onReloadLocalRuntime: reloadLocalRuntime,
      });

      if (
        !isBetaChannel &&
        shouldEnableAutoUpdates({
          isPackaged: app.isPackaged,
          platform: process.platform,
        })
      ) {
        initAutoUpdater(mainWindow);
        setTimeout(() => checkForUpdates(), 3_000);
      }

      app.on("activate", () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          mainWindow = createWindow({ hideOnClose: true });
          createTray(mainWindow, {
            enableUpdates: !isBetaChannel,
            onOpenSystemMonitor: openSystemMonitor,
            onReloadLocalRuntime: reloadLocalRuntime,
          });
          return;
        }
        mainWindow.show();
        mainWindow.focus();
      });
    } catch (error) {
      console.error("[electron] failed to initialize application", error);
      dialog.showErrorBox("Application Failed to Start", String(error));
      app.quit();
    }
  });
}

app.on("before-quit", (event) => {
  setIsQuitting(true);
  writeBetaDesktopStatus(new Date().toISOString());

  if (packagedBackendsStoppedForQuit) {
    return;
  }

  event.preventDefault();
  if (stoppingPackagedBackendsForQuit) {
    return;
  }

  stoppingPackagedBackendsForQuit = true;
  void (async () => {
    await Promise.allSettled([
      cdpProxyRuntime?.stop() ?? Promise.resolve(),
      packagedBackendRuntime?.stop() ?? Promise.resolve(),
    ]);
    packagedBackendsStoppedForQuit = true;
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
