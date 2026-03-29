import type { PtyRuntime } from "./pty-service";

interface RuntimeSubscriber {
  onData(data: string): void;
  onExit(event: { exitCode: number; signal?: number }): void;
}

interface RuntimeEntry {
  runtime: PtyRuntime;
  attachedClients: Set<string>;
  bufferedOutput: string;
  subscribers: Set<RuntimeSubscriber>;
}

export class TerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private static readonly MAX_BUFFERED_OUTPUT_LENGTH = 64 * 1024;

  createRuntime(terminalSessionId: string, runtime: PtyRuntime): void {
    const entry: RuntimeEntry = {
      runtime,
      attachedClients: new Set<string>(),
      bufferedOutput: "",
      subscribers: new Set<RuntimeSubscriber>(),
    };

    runtime.onData((data) => {
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

  getRuntime(terminalSessionId: string): PtyRuntime | undefined {
    return this.runtimes.get(terminalSessionId)?.runtime;
  }

  getBufferedOutput(terminalSessionId: string): string {
    return this.runtimes.get(terminalSessionId)?.bufferedOutput ?? "";
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
