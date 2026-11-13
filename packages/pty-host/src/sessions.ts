import { createHash, randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { PtyHostBinding, PtyHostCreateSession, PtyHostSession } from "@runweave/shared/terminal/pty-host";
import { isInteractiveShellLaunch } from "@runweave/shared/terminal/shell";
import { InputOperations } from "./input-operations";
import { TerminalOutputRecoveryBuffer, type TerminalOutputFrame } from "./output-recovery";
import { TerminalOutputScreen } from "./output-screen";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@runweave/shared/terminal-limits";
import { reportHostDiagnostic, writeHostDiagnostic } from "./diagnostics";

const requireNative = createRequire(fileURLToPath(import.meta.url));
export class HostSession {
  readonly info: PtyHostSession;
  readonly buffer = new TerminalOutputRecoveryBuffer();
  readonly screen: TerminalOutputScreen;
  readonly inputs: InputOperations;
  readonly createDigest: string;
  readonly outputListeners = new Set<(frame: TerminalOutputFrame) => void>();
  readonly exitListeners = new Set<(exitCode: number) => void>();
  readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  readonly launchListeners = new Set<(launch: NonNullable<PtyHostSession["launch"]>) => void>();
  degraded = false;
  private terminal!: IPty;
  private fallbackActivated = false;
  private closing = false;
  private nativeClosing = false;
  private processGeneration = 0;
  private startupDeadline = 0;

  constructor(hostInstanceId: string, private readonly options: PtyHostCreateSession, private readonly prepareEnv: (token: string, sessionId: string) => Record<string, string | undefined>) {
    this.createDigest = createHash("sha256").update(JSON.stringify(options)).digest("hex");
    this.info = {
      hostInstanceId, sessionInstanceId: options.sessionInstanceId, terminalSessionId: options.terminalSessionId,
      projectId: options.projectId, gatewayToken: randomUUID() + randomUUID(), pid: 0,
      status: "running", cols: options.cols, rows: options.rows, nextSequence: 1,
    };
    this.screen = new TerminalOutputScreen(this.buffer.cursor, failure => {
      this.degraded = true;
      reportHostDiagnostic(writeHostDiagnostic, { event: "pty-host.mirror.failed", hostInstanceId,
        terminalSessionId: options.terminalSessionId, ...failure });
    }, TERMINAL_CLIENT_SCROLLBACK_LINES, data => {
      if (!this.nativeClosing && this.info.status === "running") this.terminal?.write(data);
    });
    this.screen.resize(options.cols, options.rows);
    this.inputs = new InputOperations(data => this.terminal.write(data), () => this.info.status === "running", () => this.processGeneration);
    try { this.spawn(options); }
    catch (error) {
      try { if (!this.activateFallback(String(error))) throw error; }
      catch (fallbackError) { this.screen.dispose(); throw fallbackError; }
    }
  }

  private emitOutput(data: string): void {
    for (const frame of this.buffer.append(data)) {
      if (!this.degraded) this.screen.append(frame);
      for (const listener of this.outputListeners) listener(frame);
    }
  }

  private activateFallback(reason: string): boolean {
    if (!this.options.fallback || this.fallbackActivated || this.closing || !isInteractiveShellLaunch(this.options)) return false;
    this.fallbackActivated = true;
    this.emitOutput("[Runweave: shell failed to start; using system default: " + this.options.fallback.command + "]\r\n");
    this.spawn(this.options.fallback, reason);
    return true;
  }

  private spawn(launch: { command: string; args: string[]; env: Record<string, string | undefined> }, fallbackReason?: string): void {
    const pty = requireNative("node-pty") as typeof import("node-pty");
    const started = Date.now();
    const terminal = pty.spawn(launch.command, launch.args, {
      name: "xterm-256color", cols: this.info.cols, rows: this.info.rows, cwd: this.options.cwd,
      useConptyDll: process.platform === "win32",
      env: { ...launch.env, ...this.prepareEnv(this.info.gatewayToken, this.info.terminalSessionId) },
    });
    this.startupDeadline = this.options.fallback && isInteractiveShellLaunch(this.options) ? Date.now() + 1000 : 0;
    this.processGeneration++;
    this.terminal = terminal;
    this.info.pid = terminal.pid;
    this.info.launch = { command: launch.command, args: [...launch.args], ...(fallbackReason ? { fallbackReason } : {}) };
    for (const listener of this.launchListeners) listener(this.info.launch);
    terminal.onData(data => { if (this.terminal === terminal) this.emitOutput(data); });
    terminal.onExit(event => {
      if (this.terminal !== terminal) return;
      if (event.exitCode > 0 && Date.now() - started < 1000) {
        try { if (this.activateFallback(`Shell exited with code ${event.exitCode}`)) return; }
        catch (error) { this.emitOutput(`[Runweave: system shell failed to start: ${String(error)}]\r\n`); }
      }
      this.info.status = "exited";
      this.info.exitCode = event.exitCode;
      for (const listener of this.exitListeners) listener(event.exitCode);
    });
  }

  async ready(): Promise<PtyHostSession> {
    const deadline = Date.now() + 10_000;
    while ((this.terminal.pid < 1 || Date.now() < this.startupDeadline) && this.info.status === "running" && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    this.info.pid = this.terminal.pid;
    if (this.info.pid < 1) { this.close(); throw new Error("HOST_SESSION_START_FAILED"); }
    return this.describe();
  }

  describe(): PtyHostSession { return { ...this.info, nextSequence: this.inputs.nextSequence }; }

  assertBinding(binding: PtyHostBinding): void {
    if (binding.hostInstanceId !== this.info.hostInstanceId || binding.sessionInstanceId !== this.info.sessionInstanceId)
      throw new Error("HOST_IDENTITY_MISMATCH");
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 200)
      throw new Error("HOST_SIZE_INVALID");
    if (!this.degraded) this.screen.resize(cols, rows);
    this.info.cols = cols;
    this.info.rows = rows;
    for (const listener of this.resizeListeners) listener(cols, rows);
    this.terminal.resize(cols, rows);
  }

  signal(signal: string): void {
    if (!["SIGINT", "SIGTERM", "SIGKILL"].includes(signal)) throw new Error("HOST_SIGNAL_INVALID");
    this.closing = true;
    if (process.platform === "win32") {
      if (signal === "SIGINT") this.terminal.write("\x03"); else this.close();
    } else { this.nativeClosing = signal !== "SIGINT"; this.terminal.kill(signal); }
  }

  close(): void {
    if (this.info.status !== "running") return;
    this.closing = true;
    this.nativeClosing = true;
    this.terminal.kill();
  }

  snapshot() {
    if (this.degraded) return Promise.resolve({
      data: "\x1b[0m\x1b[2J\x1b[H[Runweave: screen recovery unavailable; the original process is still running.]\r\n",
      cursor: this.buffer.cursor, cols: this.info.cols, rows: this.info.rows,
    });
    return this.screen.snapshot();
  }
}
