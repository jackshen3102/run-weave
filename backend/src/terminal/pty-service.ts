import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type IPty } from "node-pty";
import type { TerminalSignal } from "@browser-viewer/shared";

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

const require = createRequire(import.meta.url);

function ensureSpawnHelperExecutable(): void {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const helperPath = path.join(
      path.dirname(packageJsonPath),
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

  return merged;
}

export class PtyService {
  private readonly spawnImpl: NonNullable<PtyServiceDependencies["spawn"]>;

  constructor(dependencies?: PtyServiceDependencies) {
    this.spawnImpl =
      dependencies?.spawn ??
      ((file, args, options) => spawn(file, args, options) as unknown as IPty);
  }

  spawnSession(options: SpawnTerminalSessionOptions): PtyRuntime {
    ensureSpawnHelperExecutable();

    const processEnv = buildPtyEnv(process.env, options.env);
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
