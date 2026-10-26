import type { PtyRuntime } from "./pty-service";
import {
  TerminalOutputRecoveryBuffer,
  type TerminalOutputFrame,
} from "./output-recovery";
import { extractShellPromptMetadata } from "./shell-integration";
import { TerminalOutputScreen } from "./output-screen";
import { TerminalOutputClients } from "./output-clients";
import { RESUME_WINDOW_MS } from "./output-recovery";

const ESCAPE = "\u001b";
const BRACKETED_PASTE_MODE_PATTERN = new RegExp(
  `${ESCAPE}\\[\\?2004([hl])`,
  "g",
);
const TERMINAL_MODE_SEQUENCE_TAIL_LENGTH = 7;

interface RuntimeSubscriber {
  onData(data: string): void;
  onOutputFrame?(frame: TerminalOutputFrame): void;
  onResize?(cols: number, rows: number): void;
  onRecoveryError?(): void;
  onExit(event: { exitCode: number; signal?: number }): void;
}

interface RuntimeEntry {
  terminalSessionId: string;
  runtime: PtyRuntime;
  attachedClients: Set<string>;
  bufferedOutput: string;
  bracketedPasteMode: boolean | null;
  terminalModeSequenceTail: string;
  subscribers: Set<RuntimeSubscriber>;
  recorderAttached: boolean;
  outputRecovery?: TerminalOutputRecoveryBuffer;
  outputScreen?: TerminalOutputScreen;
  idleTimer?: NodeJS.Timeout;
  cols: number;
  rows: number;
}

export class TerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly idle = new Map<string, RuntimeEntry>();
  readonly outputClients = new TerminalOutputClients();
  private static readonly MAX_BUFFERED_OUTPUT_LENGTH = 64 * 1024;

  createRuntime(
    terminalSessionId: string,
    runtime: PtyRuntime,
    options: { recoverableOutput?: boolean; runtimeId?: string } = {},
  ): void {
    const runtimeId = options.runtimeId ?? terminalSessionId;
    const entry: RuntimeEntry = {
      terminalSessionId,
      runtime,
      attachedClients: new Set<string>(),
      bufferedOutput: "",
      bracketedPasteMode: null,
      terminalModeSequenceTail: "",
      subscribers: new Set<RuntimeSubscriber>(),
      recorderAttached: false,
      cols: 80,
      rows: 24,
      outputRecovery: options.recoverableOutput
        ? new TerminalOutputRecoveryBuffer()
        : undefined,
    };

    if (entry.outputRecovery) {
      entry.outputScreen = new TerminalOutputScreen(
        entry.outputRecovery.cursor,
        () => {
          for (const subscriber of entry.subscribers)
            subscriber.onRecoveryError?.();
          void this.disposeRuntime(runtimeId);
        },
      );
      entry.runtime = {
        ...runtime,
        resize: (cols, rows) => {
          const changed = entry.cols !== cols || entry.rows !== rows;
          if (changed) entry.outputScreen!.resize(cols, rows);
          // Publish the grid boundary before any output from the resized PTY.
          // Unchanged requests still need an acknowledgement for the viewer.
          for (const subscriber of entry.subscribers)
            subscriber.onResize?.(cols, rows);
          if (changed) runtime.resize(cols, rows);
          entry.cols = cols;
          entry.rows = rows;
        },
      };
    }
    this.runtimes.set(runtimeId, entry);

    runtime.onData((data) => {
      if (this.runtimes.get(runtimeId) !== entry) return;
      const modeData = `${entry.terminalModeSequenceTail}${data}`;
      BRACKETED_PASTE_MODE_PATTERN.lastIndex = 0;
      let modeMatch = BRACKETED_PASTE_MODE_PATTERN.exec(modeData);
      while (modeMatch) {
        entry.bracketedPasteMode = modeMatch[1] === "h";
        modeMatch = BRACKETED_PASTE_MODE_PATTERN.exec(modeData);
      }
      entry.terminalModeSequenceTail = modeData.slice(
        -TERMINAL_MODE_SEQUENCE_TAIL_LENGTH,
      );
      entry.bufferedOutput = `${entry.bufferedOutput}${data}`.slice(
        -TerminalRuntimeRegistry.MAX_BUFFERED_OUTPUT_LENGTH,
      );
      if (entry.outputRecovery) {
        const { output } = extractShellPromptMetadata(data);
        for (const frame of entry.outputRecovery.append(output)) {
          entry.outputScreen!.append(frame);
          if (this.runtimes.get(runtimeId) !== entry) return;
          for (const subscriber of entry.subscribers)
            subscriber.onOutputFrame?.(frame);
        }
      }
      for (const subscriber of entry.subscribers) {
        subscriber.onData(data);
      }
    });

    runtime.onExit((event) => {
      if (this.runtimes.get(runtimeId) !== entry) return;
      for (const subscriber of entry.subscribers) {
        subscriber.onExit(event);
      }
    });
  }

  ensureRecorder(terminalSessionId: string, recorder: RuntimeSubscriber): void {
    const entry = this.runtimes.get(terminalSessionId);
    if (!entry || entry.recorderAttached) {
      return;
    }

    entry.subscribers.add(recorder);
    entry.recorderAttached = true;
  }

  getRuntime(runtimeId: string): PtyRuntime | undefined {
    return this.runtimes.get(runtimeId)?.runtime;
  }

  /** Control-plane input may use an existing display without creating another attach. */
  getSessionRuntime(terminalSessionId: string): PtyRuntime | undefined {
    for (const entry of this.runtimes.values()) {
      if (entry.terminalSessionId === terminalSessionId && entry.attachedClients.size)
        return entry.runtime;
    }
    return this.getRuntime(terminalSessionId);
  }

  /** A display cursor and its VT grid belong to one viewer, not the shared pane. */
  displayRuntimeId(terminalSessionId: string, viewerId: string): string {
    return JSON.stringify([terminalSessionId, viewerId]);
  }

  getBufferedOutput(runtimeId: string): string {
    return this.runtimes.get(runtimeId)?.bufferedOutput ?? "";
  }

  getOutputRecovery(
    runtimeId: string,
  ): TerminalOutputRecoveryBuffer | undefined {
    return this.runtimes.get(runtimeId)?.outputRecovery;
  }

  getOutputScreen(runtimeId: string): TerminalOutputScreen | undefined {
    return this.runtimes.get(runtimeId)?.outputScreen;
  }

  retainIdleRuntime(runtimeId: string): void {
    const entry = this.runtimes.get(runtimeId);
    if (!entry || entry.attachedClients.size || entry.idleTimer) return;
    if (!entry.outputRecovery) {
      void this.disposeRuntime(runtimeId);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (
        this.runtimes.get(runtimeId) === entry &&
        !entry.attachedClients.size
      )
        void this.disposeRuntime(runtimeId);
    }, RESUME_WINDOW_MS);
    entry.idleTimer.unref();
    this.idle.set(runtimeId, entry);
    while (this.idle.size > 8)
      void this.disposeRuntime(this.idle.keys().next().value!);
  }

  getBracketedPasteMode(runtimeId: string): boolean | null {
    return this.runtimes.get(runtimeId)?.bracketedPasteMode ?? null;
  }

  subscribe(
    runtimeId: string,
    subscriber: RuntimeSubscriber,
  ): () => void {
    const entry = this.runtimes.get(runtimeId);
    if (!entry) {
      return () => undefined;
    }

    entry.subscribers.add(subscriber);
    return () => {
      entry.subscribers.delete(subscriber);
    };
  }

  attachClient(runtimeId: string, clientId: string): void {
    const entry = this.runtimes.get(runtimeId);
    if (!entry) {
      return;
    }

    entry.attachedClients.add(clientId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    this.idle.delete(runtimeId);
  }

  detachClient(runtimeId: string, clientId: string): void {
    const entry = this.runtimes.get(runtimeId);
    if (!entry) {
      return;
    }

    entry.attachedClients.delete(clientId);
  }

  getAttachedClientCount(runtimeId: string): number {
    return this.runtimes.get(runtimeId)?.attachedClients.size ?? 0;
  }

  async disposeRuntime(runtimeId: string): Promise<void> {
    const entry = this.runtimes.get(runtimeId);
    if (!entry) {
      return;
    }

    this.runtimes.delete(runtimeId);
    this.idle.delete(runtimeId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.outputClients.forget(runtimeId);
    entry.outputScreen?.dispose();
    entry.runtime.dispose();
  }

  async disposeAll(): Promise<void> {
    const runtimeIds = Array.from(this.runtimes.keys());

    for (const runtimeId of runtimeIds) {
      await this.disposeRuntime(runtimeId);
    }
  }

  async disposeSessionRuntimes(terminalSessionId: string): Promise<void> {
    for (const [runtimeId, entry] of this.runtimes) {
      if (entry.terminalSessionId === terminalSessionId)
        await this.disposeRuntime(runtimeId);
    }
  }
}
