import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  getTerminalBrowserProfileConfig,
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserErrorPayload,
  type TerminalBrowserProfileId,
  type TerminalBrowserWhistleState,
} from "@runweave/shared/terminal-browser-profile";
import { TerminalBrowserError } from "./terminal-browser-errors.js";
import { getWhistleStatus } from "./terminal-browser-whistle-client.js";

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const STOP_TIMEOUT_MS = 3_000;

interface WhistleRecord {
  child: ChildProcess | null;
  startPromise: Promise<TerminalBrowserWhistleState> | null;
  state: TerminalBrowserWhistleState;
}

const records = new Map<TerminalBrowserProfileId, WhistleRecord>(
  TERMINAL_BROWSER_PROFILE_IDS.map((profileId) => {
    const config = getTerminalBrowserProfileConfig(profileId);
    return [
      profileId,
      {
        child: null,
        startPromise: null,
        state: {
          profileId,
          status: "stopped",
          host: "127.0.0.1",
          port: config.whistlePort,
          storage: config.whistleStorage,
          pid: null,
          error: null,
        },
      },
    ];
  }),
);
let startQueue = Promise.resolve();
export const terminalBrowserWhistleEvents = new EventEmitter();

function errorPayload(error: unknown): TerminalBrowserErrorPayload {
  if (error instanceof TerminalBrowserError) {
    return error.toPayload();
  }
  return {
    code: "WHISTLE_START_FAILED",
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function notifyWhistleChanged(state: TerminalBrowserWhistleState): void {
  terminalBrowserWhistleEvents.emit("changed", structuredClone(state));
}

function updateState(
  profileId: TerminalBrowserProfileId,
  patch: Partial<TerminalBrowserWhistleState>,
): TerminalBrowserWhistleState {
  const record = records.get(profileId)!;
  record.state = { ...record.state, ...patch };
  notifyWhistleChanged(record.state);
  return structuredClone(record.state);
}

function resolveWhistleEntrypoint(): string {
  const relative = path.join("node_modules", "whistle", "index.js");
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "whistle-runtime", relative);
  }
  const candidates = [
    path.join(app.getAppPath(), "packages", "whistle-runtime", relative),
    path.join(app.getAppPath(), "..", "packages", "whistle-runtime", relative),
    path.join(__dirname, "..", "..", "packages", "whistle-runtime", relative),
  ];
  const entrypoint = candidates.find(existsSync);
  if (!entrypoint) {
    throw new Error("Whistle runtime entrypoint is missing");
  }
  return entrypoint;
}

function signalWhistleProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }
  }
  child.kill(signal);
}

function whistleProcessGroupIsAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (!pid) {
    return false;
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateWhistleProcessGroup(child: ChildProcess): Promise<void> {
  signalWhistleProcessGroup(child, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (whistleProcessGroupIsAlive(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (whistleProcessGroupIsAlive(child)) {
    signalWhistleProcessGroup(child, "SIGKILL");
  }
}

function getWhistleBaseDir(): string {
  return path.join(app.getPath("userData"), "terminal-browser-whistle");
}

export function getTerminalBrowserWhistleCertificateDirectory(): string {
  return path.join(getWhistleBaseDir(), "certs");
}

async function isPortAcceptingConnections(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitUntilReady(
  profileId: TerminalBrowserProfileId,
  child: ChildProcess,
): Promise<void> {
  const config = getTerminalBrowserProfileConfig(profileId);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "Whistle did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Whistle exited before it became ready (${child.exitCode ?? child.signalCode})`,
      );
    }
    try {
      const status = await getWhistleStatus(config.whistlePort);
      if (status.storage !== config.whistleStorage) {
        throw new TerminalBrowserError(
          "WHISTLE_PORT_IN_USE",
          `Port ${config.whistlePort} belongs to another Whistle storage`,
          {
            expectedStorage: config.whistleStorage,
            actualStorage: status.storage,
          },
        );
      }
      return;
    } catch (error) {
      if (error instanceof TerminalBrowserError) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`Whistle readiness timed out: ${lastError}`);
}

async function startOwnedWhistle(
  profileId: TerminalBrowserProfileId,
): Promise<TerminalBrowserWhistleState> {
  const config = getTerminalBrowserProfileConfig(profileId);
  const record = records.get(profileId)!;
  updateState(profileId, { status: "starting", pid: null, error: null });

  if (await isPortAcceptingConnections(config.whistlePort)) {
    const error = new TerminalBrowserError(
      "WHISTLE_PORT_IN_USE",
      `Whistle port ${config.whistlePort} is already in use`,
      { profileId, port: config.whistlePort },
    );
    updateState(profileId, {
      status: "failed",
      pid: null,
      error: error.toPayload(),
    });
    throw error;
  }

  const baseDir = getWhistleBaseDir();
  const certDir = getTerminalBrowserWhistleCertificateDirectory();
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(certDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      // Keep the detached proxy bound to Electron's lifetime after a crash.
      [
        'process.once("disconnect", () => process.exit(0));',
        "require(process.argv[1])(JSON.parse(process.argv[2]));",
      ].join(""),
      resolveWhistleEntrypoint(),
      JSON.stringify({
        host: "127.0.0.1",
        port: String(config.whistlePort),
        storage: config.whistleStorage,
        baseDir,
        certDir,
        noGlobalPlugins: true,
        clearPreOptions: true,
        debugMode: true,
      }),
    ],
    {
      detached: process.platform !== "win32",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  record.child = child;
  let output = "";
  const capture = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", (code, signal) => {
    if (record.child !== child) {
      return;
    }
    record.child = null;
    if (record.state.status === "ready") {
      updateState(profileId, {
        status: "failed",
        pid: null,
        error: {
          code: "WHISTLE_START_FAILED",
          message: `Whistle exited unexpectedly (${code ?? signal})`,
          details: { profileId, output },
        },
      });
    }
  });

  try {
    await waitUntilReady(profileId, child);
    return updateState(profileId, {
      status: "ready",
      pid: child.pid ?? null,
      error: null,
    });
  } catch (error) {
    await terminateWhistleProcessGroup(child);
    record.child = null;
    const payload = errorPayload(error);
    updateState(profileId, { status: "failed", pid: null, error: payload });
    throw error instanceof TerminalBrowserError
      ? error
      : new TerminalBrowserError(
          "WHISTLE_START_FAILED",
          `Failed to start Whistle for ${profileId}`,
          { profileId, output, cause: payload.message },
        );
  }
}

export function getTerminalBrowserWhistleState(
  profileId: TerminalBrowserProfileId,
): TerminalBrowserWhistleState {
  return structuredClone(records.get(profileId)!.state);
}

export async function ensureTerminalBrowserWhistle(
  profileId: TerminalBrowserProfileId,
): Promise<TerminalBrowserWhistleState> {
  const record = records.get(profileId)!;
  if (record.state.status === "ready" && record.child) {
    return structuredClone(record.state);
  }
  if (record.startPromise) {
    return await record.startPromise;
  }
  record.startPromise = startQueue
    .then(() => startOwnedWhistle(profileId))
    .finally(() => {
      record.startPromise = null;
    });
  startQueue = record.startPromise.then(
    () => undefined,
    () => undefined,
  );
  return await record.startPromise;
}

async function stopOne(profileId: TerminalBrowserProfileId): Promise<void> {
  const record = records.get(profileId)!;
  const child = record.child;
  record.child = null;
  if (child) {
    await terminateWhistleProcessGroup(child);
  }
  updateState(profileId, { status: "stopped", pid: null, error: null });
}

export async function stopAllTerminalBrowserWhistles(): Promise<void> {
  await Promise.all(TERMINAL_BROWSER_PROFILE_IDS.map(stopOne));
}
