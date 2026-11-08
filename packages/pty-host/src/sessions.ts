import { createHash, randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { PtyHostBinding, PtyHostCreateSession, PtyHostSession } from "@runweave/shared/terminal/pty-host";
import { InputOperations } from "./input-operations";
import { TerminalOutputRecoveryBuffer, type TerminalOutputFrame } from "./output-recovery";
import { TerminalOutputScreen } from "./output-screen";

const requireNative = createRequire(fileURLToPath(import.meta.url));
export class HostSession {
  readonly info: PtyHostSession;
  readonly buffer = new TerminalOutputRecoveryBuffer();
  readonly screen: TerminalOutputScreen;
  readonly inputs: InputOperations;
  readonly createDigest: string;
  readonly outputListeners = new Set<(frame: TerminalOutputFrame) => void>();
  readonly exitListeners = new Set<(exitCode: number) => void>();
  degraded = false;
  private readonly terminal: IPty;

  constructor(hostInstanceId: string, options: PtyHostCreateSession, prepareEnv: (token: string, sessionId: string) => Record<string, string | undefined>) {
    this.createDigest = createHash("sha256").update(JSON.stringify(options)).digest("hex");
    this.info = {
      hostInstanceId, sessionInstanceId: options.sessionInstanceId, terminalSessionId: options.terminalSessionId,
      projectId: options.projectId, gatewayToken: randomUUID() + randomUUID(), pid: 0,
      status: "running", cols: options.cols, rows: options.rows, nextSequence: 1,
    };
    this.screen = new TerminalOutputScreen(this.buffer.cursor, () => { this.degraded = true; });
    this.screen.resize(options.cols, options.rows);
    const pty = requireNative("node-pty") as typeof import("node-pty");
    this.terminal = pty.spawn(options.command, options.args, {
      name: "xterm-256color", cols: options.cols, rows: options.rows, cwd: options.cwd,
      env: { ...options.env, ...prepareEnv(this.info.gatewayToken, this.info.terminalSessionId) },
    });
    this.inputs = new InputOperations(data => this.terminal.write(data), () => this.info.status === "running");
    this.terminal.onData(data => {
      this.info.pid = this.terminal.pid;
      for (const frame of this.buffer.append(data)) {
        if (!this.degraded) this.screen.append(frame);
        for (const listener of this.outputListeners) listener(frame);
      }
    });
    this.terminal.onExit(event => {
      this.info.status = "exited";
      this.info.exitCode = event.exitCode;
      for (const listener of this.exitListeners) listener(event.exitCode);
    });
  }

  async ready(): Promise<PtyHostSession> {
    const deadline = Date.now() + 10_000;
    while (this.terminal.pid < 1 && this.info.status === "running" && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    this.info.pid = this.terminal.pid;
    if (this.info.pid < 1) throw new Error("HOST_SESSION_START_FAILED");
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
    this.terminal.resize(cols, rows);
    this.info.cols = cols;
    this.info.rows = rows;
  }

  signal(signal: string): void {
    if (!["SIGINT", "SIGTERM", "SIGKILL"].includes(signal)) throw new Error("HOST_SIGNAL_INVALID");
    if (process.platform === "win32") {
      if (signal === "SIGINT") this.terminal.write("\x03"); else this.close();
    } else this.terminal.kill(signal);
  }

  close(): void {
    if (this.info.status !== "running") return;
    this.terminal.kill();
  }

  snapshot() {
    if (this.degraded) throw new Error("HOST_SCREEN_UNAVAILABLE");
    return this.screen.snapshot();
  }
}
