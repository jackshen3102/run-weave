import type { PtyRuntime } from "./pty-service";

const ESCAPE = "\u001b";
const BRACKETED_PASTE_MODE_PATTERN = new RegExp(
  `${ESCAPE}\\[\\?2004([hl])`,
  "g",
);
const TERMINAL_MODE_SEQUENCE_TAIL_LENGTH = 7;

interface RuntimeSubscriber {
  onData(data: string): void;
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
}

export class TerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private static readonly MAX_BUFFERED_OUTPUT_LENGTH = 64 * 1024;

  createRuntime(terminalSessionId: string, runtime: PtyRuntime): void {
    const entry: RuntimeEntry = {
      runtime,
      attachedClients: new Set<string>(),
      bufferedOutput: "",
      bracketedPasteMode: null,
      terminalModeSequenceTail: "",
      subscribers: new Set<RuntimeSubscriber>(),
      recorderAttached: false,
    };

    runtime.onData((data) => {
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
      for (const subscriber of entry.subscribers) {
        subscriber.onData(data);
      }
    });

    runtime.onExit((event) => {
      for (const subscriber of entry.subscribers) {
        subscriber.onExit(event);
      }
    });

    this.runtimes.set(terminalSessionId, entry);
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

    entry.runtime.dispose();
    this.runtimes.delete(terminalSessionId);
  }

  async disposeAll(): Promise<void> {
    const terminalSessionIds = Array.from(this.runtimes.keys());

    for (const terminalSessionId of terminalSessionIds) {
      await this.disposeRuntime(terminalSessionId);
    }
  }
}
