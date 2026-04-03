import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { TerminalSignal } from "@browser-viewer/shared";
import { resolveNodePtyDirectory } from "./node-pty-path";
import { applyShellIntegration } from "./shell-integration";

export interface SpawnTerminalSessionOptions {
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PtyRuntime {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  signal(signal: TerminalSignal): void;
  dispose(): void;
}

interface PtySpawnResult {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
}

interface PtyServiceDependencies {
  spawn?: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ) => PtySpawnResult;
}

const require = createRequire(
  path.join(process.cwd(), "__browser_viewer_node_pty_loader__.cjs"),
);

function loadNodePtyModule(): typeof import("node-pty") {
  const configuredDir = resolveNodePtyDirectory(process.env);

  if (configuredDir) {
    return require(path.join(configuredDir, "lib", "index.js")) as typeof import("node-pty");
  }

  return require("node-pty") as typeof import("node-pty");
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const nodePtyDir =
      resolveNodePtyDirectory(process.env) ??
      path.dirname(require.resolve("node-pty/package.json"));
    const helperPath = path.join(
      nodePtyDir,
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    );
    const currentMode = statSync(helperPath).mode & 0o777;
    const executableMode = currentMode | 0o111;

    if (currentMode !== executableMode) {
      chmodSync(helperPath, executableMode);
    }
  } catch (error) {
    console.error("[viewer-be] failed to prepare node-pty spawn-helper", {
      error: String(error),
    });
  }
}

function toTerminalSignal(signal: TerminalSignal): string {
  return signal;
}

function buildPtyEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionEnv: NodeJS.ProcessEnv | undefined,
  command: string,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...sessionEnv,
  };
  const currentTerm = merged.TERM?.trim();
  if (!currentTerm || currentTerm === "dumb") {
    merged.TERM = "xterm-256color";
  }
  if (!merged.COLORTERM?.trim()) {
    merged.COLORTERM = "truecolor";
  }

  return applyShellIntegration(command, merged);
}

export class PtyService {
  private readonly spawnImpl: NonNullable<PtyServiceDependencies["spawn"]>;

  constructor(dependencies?: PtyServiceDependencies) {
    this.spawnImpl =
      dependencies?.spawn ??
      ((file, args, options) =>
        loadNodePtyModule().spawn(file, args, options) as unknown as IPty);
  }

  spawnSession(options: SpawnTerminalSessionOptions): PtyRuntime {
    ensureSpawnHelperExecutable();

    const processEnv = buildPtyEnv(process.env, options.env, options.command);
    const ptyProcess = this.spawnImpl(options.command, options.args ?? [], {
      name: "xterm-256color",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: processEnv,
    });

    return {
      pid: ptyProcess.pid,
      onData(listener) {
        ptyProcess.onData(listener);
      },
      onExit(listener) {
        ptyProcess.onExit(listener);
      },
      write(data) {
        ptyProcess.write(data);
      },
      resize(cols, rows) {
        ptyProcess.resize(cols, rows);
      },
      signal(signal) {
        ptyProcess.kill(toTerminalSignal(signal));
      },
      dispose() {
        ptyProcess.kill();
      },
    };
  }
}
