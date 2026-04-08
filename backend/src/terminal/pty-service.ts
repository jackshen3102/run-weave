import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { TerminalSignal } from "@browser-viewer/shared";
import type { TerminalLaunchConfig } from "./default-shell";
import { resolveNodePtyDirectory } from "./node-pty-path";
import { applyShellIntegration } from "./shell-integration";
import backendPackageJson from "../../package.json";

export interface SpawnTerminalSessionOptions {
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  fallback?: TerminalLaunchConfig | null;
  onFallbackActivated?: (fallback: TerminalLaunchConfig) => void;
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

const QUICK_EXIT_FALLBACK_THRESHOLD_MS = 1_000;
const TERMINAL_PROGRAM_NAME = "browser-viewer";

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

function isUnsetEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim();
  return !normalized || normalized === "undefined" || normalized === "null";
}

function normalizePathForAppImage(env: NodeJS.ProcessEnv): void {
  if (isUnsetEnvValue(env.APPIMAGE) || isUnsetEnvValue(env.APPDIR)) {
    return;
  }

  const appDir = env.APPDIR!.trim();
  const currentPath = env.PATH ?? "";
  env.PATH = currentPath
    .split(path.delimiter)
    .filter((entry) => entry && !entry.startsWith(appDir))
    .join(path.delimiter);
  delete env.APPIMAGE;
  delete env.APPDIR;
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
  if (isUnsetEnvValue(merged.COLORTERM)) {
    merged.COLORTERM = "truecolor";
  }
  if (isUnsetEnvValue(merged.LANG)) {
    merged.LANG = "en_US.UTF-8";
  }
  if (isUnsetEnvValue(merged.TERM_PROGRAM)) {
    merged.TERM_PROGRAM = TERMINAL_PROGRAM_NAME;
  }
  if (isUnsetEnvValue(merged.TERM_PROGRAM_VERSION)) {
    merged.TERM_PROGRAM_VERSION = backendPackageJson.version;
  }
  if (
    !isUnsetEnvValue(baseEnv.GOOGLE_API_KEY) &&
    merged.GOOGLE_API_KEY === baseEnv.GOOGLE_API_KEY
  ) {
    delete merged.GOOGLE_API_KEY;
  }

  normalizePathForAppImage(merged);

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
    const pendingData: string[] = [];
    let pendingExit: { exitCode: number; signal?: number } | null = null;
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<
      (event: { exitCode: number; signal?: number }) => void
    >();
    const normalizedArgs = [...(options.args ?? [])];
    const fallback = options.fallback
      ? {
          command: options.fallback.command,
          args: [...options.fallback.args],
        }
      : null;
    let latestCols = options.cols ?? 80;
    let latestRows = options.rows ?? 24;
    let currentRuntime: PtyRuntime | null = null;
    let currentPid = -1;
    let disposed = false;
    let fallbackActivated = false;
    let launchStartedAt = Date.now();

    const emitData = (data: string) => {
      if (dataListeners.size === 0) {
        pendingData.push(data);
        return;
      }

      for (const listener of dataListeners) {
        listener(data);
      }
    };

    const emitExit = (event: { exitCode: number; signal?: number }) => {
      if (exitListeners.size === 0) {
        pendingExit = event;
        return;
      }

      for (const listener of exitListeners) {
        listener(event);
      }
    };

    const formatFallbackMessage = (lines: string[]): string =>
      `${lines.join("\r\n")}\r\n`;

    const spawnRuntime = (command: string, args: string[]): PtyRuntime => {
      ensureSpawnHelperExecutable();

      const processEnv = buildPtyEnv(process.env, options.env, command);
      const ptyProcess = this.spawnImpl(command, args, {
        name: "xterm-256color",
        cols: latestCols,
        rows: latestRows,
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
    };

    const activateFallback = (
      reasonLines: string[],
      error?: unknown,
    ): void => {
      if (!fallback || fallbackActivated || disposed) {
        if (reasonLines.length > 0) {
          emitData(formatFallbackMessage(reasonLines));
        }
        if (error) {
          throw error;
        }
        return;
      }

      fallbackActivated = true;
      emitData(
        formatFallbackMessage([
          ...reasonLines,
          `using fallback shell config: ${JSON.stringify(fallback, undefined, 2)}`,
        ]),
      );
      options.onFallbackActivated?.(fallback);
      try {
        launch(fallback.command, fallback.args, true);
      } catch (fallbackError) {
        emitData(
          formatFallbackMessage([
            `fallback shell failed to start: ${String(fallbackError)}`,
          ]),
        );
        emitExit({ exitCode: 1 });
      }
    };

    const launch = (command: string, args: string[], usingFallback: boolean): void => {
      launchStartedAt = Date.now();

      let runtime: PtyRuntime;
      try {
        runtime = spawnRuntime(command, args);
      } catch (error) {
        activateFallback(
          [
            `failed to spawn shell: ${String(error)}`,
            `please check the shell config: ${JSON.stringify(
              { command, args },
              undefined,
              2,
            )}`,
          ],
          error,
        );
        return;
      }

      currentRuntime = runtime;
      currentPid = runtime.pid;
      runtime.onData((data) => {
        emitData(data);
      });
      runtime.onExit((event) => {
        if (disposed || currentRuntime !== runtime) {
          return;
        }

        const runDuration = Date.now() - launchStartedAt;
        const shouldFallback =
          !usingFallback &&
          !fallbackActivated &&
          event.exitCode > 0 &&
          runDuration < QUICK_EXIT_FALLBACK_THRESHOLD_MS;
        if (shouldFallback) {
          activateFallback([
            `shell exited in ${runDuration} ms with exit code ${event.exitCode}`,
            `please check the shell config: ${JSON.stringify(
              { command, args },
              undefined,
              2,
            )}`,
          ]);
          return;
        }

        if (!usingFallback && event.exitCode > 0 && runDuration < QUICK_EXIT_FALLBACK_THRESHOLD_MS) {
          emitData(
            formatFallbackMessage([
              `shell exited in ${runDuration} ms with exit code ${event.exitCode}`,
              "No fallback available, please check the shell config.",
            ]),
          );
        }

        emitExit(event);
      });
    };

    launch(options.command, normalizedArgs, false);

    return {
      get pid() {
        return currentPid;
      },
      onData(listener) {
        dataListeners.add(listener);
        if (pendingData.length > 0) {
          for (const chunk of pendingData) {
            listener(chunk);
          }
          pendingData.length = 0;
        }
      },
      onExit(listener) {
        exitListeners.add(listener);
        if (pendingExit) {
          listener(pendingExit);
          pendingExit = null;
        }
      },
      write(data) {
        currentRuntime?.write(data);
      },
      resize(cols, rows) {
        latestCols = cols;
        latestRows = rows;
        currentRuntime?.resize(cols, rows);
      },
      signal(signal) {
        currentRuntime?.signal(signal);
      },
      dispose() {
        disposed = true;
        currentRuntime?.dispose();
      },
    };
  }
}
