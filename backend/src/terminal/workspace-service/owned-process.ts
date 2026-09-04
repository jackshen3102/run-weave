import { spawn, type ChildProcess } from "node:child_process";

const OUTPUT_TAIL_BYTES = 8 * 1024;
const SUPERVISOR_START_TIMEOUT_MS = 5_000;

const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");

let child = null;
let stopping = false;
let finished = false;

function send(message) {
  if (process.connected) {
    try { process.send(message); } catch {}
  }
}

function groupIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error && error.code !== "ESRCH") throw error;
  }
}

async function terminateGroup() {
  const pid = child && child.pid;
  if (!pid || !groupIsAlive(pid)) return;
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (groupIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (groupIsAlive(pid)) signalGroup(pid, "SIGKILL");
}

async function finish(result) {
  if (finished) return;
  finished = true;
  await terminateGroup().catch(() => {});
  send({ type: "exit", ...result });
  process.exit(0);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await terminateGroup().catch(() => {});
  await finish({ code: null, signal: "SIGTERM", requested: true });
}

process.once("message", (message) => {
  if (!message || message.type !== "start") return;
  child = spawn("/bin/sh", ["-lc", message.command], {
    cwd: message.cwd,
    env: message.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("spawn", () => send({ type: "spawned", pid: child.pid }));
  child.once("error", (error) => {
    void finish({ code: null, signal: null, requested: false, error: error.message });
  });
  child.once("exit", (code, signal) => {
    void finish({ code, signal, requested: stopping });
  });
});

process.on("message", (message) => {
  if (message && message.type === "stop") void stop();
});
process.once("disconnect", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
`;

export interface OwnedWorkspaceServiceExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  requested: boolean;
  error?: string;
}

export interface OwnedWorkspaceServiceProcess {
  pid: number;
  exit: Promise<OwnedWorkspaceServiceExit>;
  getOutputTail: () => string;
  stop: () => Promise<OwnedWorkspaceServiceExit>;
}

interface SupervisorMessage {
  type?: unknown;
  pid?: unknown;
  code?: unknown;
  signal?: unknown;
  requested?: unknown;
  error?: unknown;
}

function appendOutputTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_BYTES);
}

function signalSupervisor(child: ChildProcess): void {
  if (child.connected) child.send({ type: "stop" });
}

export async function startOwnedWorkspaceServiceProcess(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<OwnedWorkspaceServiceProcess> {
  const supervisor = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let outputTail = "";
  supervisor.stdout?.on("data", (chunk: Buffer) => {
    outputTail = appendOutputTail(outputTail, chunk);
  });
  supervisor.stderr?.on("data", (chunk: Buffer) => {
    outputTail = appendOutputTail(outputTail, chunk);
  });

  let settleExit: ((value: OwnedWorkspaceServiceExit) => void) | null = null;
  const exit = new Promise<OwnedWorkspaceServiceExit>((resolve) => {
    settleExit = resolve;
  });
  let lastExit: OwnedWorkspaceServiceExit | null = null;
  const settle = (value: OwnedWorkspaceServiceExit): void => {
    if (lastExit) return;
    lastExit = value;
    settleExit?.(value);
  };

  const pid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signalSupervisor(supervisor);
      reject(new Error("Workspace service supervisor start timed out"));
    }, SUPERVISOR_START_TIMEOUT_MS);
    timeout.unref();

    const cleanupStartListeners = (): void => {
      clearTimeout(timeout);
      supervisor.off("error", handleError);
      supervisor.off("exit", handleEarlyExit);
      supervisor.off("message", handleMessage);
    };
    const handleError = (error: Error): void => {
      cleanupStartListeners();
      reject(error);
    };
    const handleEarlyExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanupStartListeners();
      reject(
        new Error(
          `Workspace service supervisor exited before spawn (${code ?? signal ?? "unknown"})`,
        ),
      );
    };
    const handleMessage = (raw: unknown): void => {
      const message = raw as SupervisorMessage;
      if (message.type !== "spawned" || typeof message.pid !== "number") return;
      cleanupStartListeners();
      resolve(message.pid);
    };

    supervisor.once("error", handleError);
    supervisor.once("exit", handleEarlyExit);
    supervisor.on("message", handleMessage);
    supervisor.send({ type: "start", ...input });
  });

  supervisor.on("message", (raw: unknown) => {
    const message = raw as SupervisorMessage;
    if (message.type !== "exit") return;
    settle({
      code: typeof message.code === "number" ? message.code : null,
      signal:
        typeof message.signal === "string"
          ? (message.signal as NodeJS.Signals)
          : null,
      requested: message.requested === true,
      ...(typeof message.error === "string" ? { error: message.error } : {}),
    });
  });
  supervisor.once("error", (error) => {
    settle({ code: null, signal: null, requested: false, error: error.message });
  });
  supervisor.once("exit", (code, signal) => {
    settle({ code, signal, requested: false });
  });

  return {
    pid,
    exit,
    getOutputTail: () => outputTail,
    stop: async () => {
      if (!lastExit) signalSupervisor(supervisor);
      return await exit;
    },
  };
}
