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
  onRecoveryError?(): void;
  onExit(event: { exitCode: number; signal?: number }): void;
}

interface RuntimeEntry {
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
    options: { recoverableOutput?: boolean } = {},
  ): void {
    const entry: RuntimeEntry = {
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
          void this.disposeRuntime(terminalSessionId);
        },
      );
      entry.runtime = {
        ...runtime,
        resize: (cols, rows) => {
          if (entry.cols === cols && entry.rows === rows) return;
          entry.outputScreen!.resize(cols, rows);
          runtime.resize(cols, rows);
          entry.cols = cols;
          entry.rows = rows;
        },
      };
    }
    this.runtimes.set(terminalSessionId, entry);

    runtime.onData((data) => {
      if (this.runtimes.get(terminalSessionId) !== entry) return;
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
          if (this.runtimes.get(terminalSessionId) !== entry) return;
          for (const subscriber of entry.subscribers)
            subscriber.onOutputFrame?.(frame);
        }
      }
      for (const subscriber of entry.subscribers) {
        subscriber.onData(data);
      }
    });

    runtime.onExit((event) => {
      if (this.runtimes.get(terminalSessionId) !== entry) return;
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

  getRuntime(terminalSessionId: string): PtyRuntime | undefined {
    return this.runtimes.get(terminalSessionId)?.runtime;
  }

  getBufferedOutput(terminalSessionId: string): string {
    return this.runtimes.get(terminalSessionId)?.bufferedOutput ?? "";
  }

  getOutputRecovery(
    terminalSessionId: string,
  ): TerminalOutputRecoveryBuffer | undefined {
    return this.runtimes.get(terminalSessionId)?.outputRecovery;
  }

  getOutputScreen(terminalSessionId: string): TerminalOutputScreen | undefined {
    return this.runtimes.get(terminalSessionId)?.outputScreen;
  }

  retainIdleRuntime(terminalSessionId: string): void {
    const entry = this.runtimes.get(terminalSessionId);
    if (!entry || entry.attachedClients.size || entry.idleTimer) return;
    if (!entry.outputRecovery) {
      void this.disposeRuntime(terminalSessionId);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (
        this.runtimes.get(terminalSessionId) === entry &&
        !entry.attachedClients.size
      )
        void this.disposeRuntime(terminalSessionId);
    }, RESUME_WINDOW_MS);
    entry.idleTimer.unref();
    this.idle.set(terminalSessionId, entry);
    while (this.idle.size > 8)
      void this.disposeRuntime(this.idle.keys().next().value!);
  }

  getBracketedPasteMode(terminalSessionId: string): boolean | null {
    return this.runtimes.get(terminalSessionId)?.bracketedPasteMode ?? null;
  }

  subscribe(
    terminalSessionId: string,
    subscriber: RuntimeSubscriber,
  ): () => void {
    const entry = this.runtimes.get(terminalSessionId);
    if (!entry) {
      return () => undefined;
    }

    entry.subscribers.add(subscriber);
    return () => {
      entry.subscribers.delete(subscriber);
    };
  }

  attachClient(terminalSessionId: string, clientId: string): void {
    const entry = this.runtimes.get(terminalSessionId);
    if (!entry) {
      return;
    }

    entry.attachedClients.add(clientId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    this.idle.delete(terminalSessionId);
  }

  detachClient(terminalSessionId: string, clientId: string): void {
    const entry = this.runtimes.get(terminalSessionId);
    if (!entry) {
      return;
    }

    entry.attachedClients.delete(clientId);
  }

  getAttachedClientCount(terminalSessionId: string): number {
    return this.runtimes.get(terminalSessionId)?.attachedClients.size ?? 0;
  }

  async disposeRuntime(terminalSessionId: string): Promise<void> {
    const entry = this.runtimes.get(terminalSessionId);
    if (!entry) {
      return;
    }

    this.runtimes.delete(terminalSessionId);
    this.idle.delete(terminalSessionId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.outputClients.forget(terminalSessionId);
    entry.outputScreen?.dispose();
    entry.runtime.dispose();
  }

  async disposeAll(): Promise<void> {
    const terminalSessionIds = Array.from(this.runtimes.keys());

    for (const terminalSessionId of terminalSessionIds) {
      await this.disposeRuntime(terminalSessionId);
    }
  }
}
