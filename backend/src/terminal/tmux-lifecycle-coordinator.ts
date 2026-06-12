export class TmuxLifecycleCoordinator {
  private readonly attachedClientCounts = new Map<string, number>();
  private readonly recoveringSessionIds = new Set<string>();

  registerAttachedClient(terminalSessionId: string): () => void {
    this.attachedClientCounts.set(
      terminalSessionId,
      (this.attachedClientCounts.get(terminalSessionId) ?? 0) + 1,
    );

    return () => {
      const count = this.attachedClientCounts.get(terminalSessionId) ?? 0;
      if (count <= 1) {
        this.attachedClientCounts.delete(terminalSessionId);
        return;
      }
      this.attachedClientCounts.set(terminalSessionId, count - 1);
    };
  }

  async runRecovery<T>(
    terminalSessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    this.recoveringSessionIds.add(terminalSessionId);
    try {
      return await action();
    } finally {
      this.recoveringSessionIds.delete(terminalSessionId);
    }
  }

  shouldFinalizeNonInteractiveExit(terminalSessionId: string): boolean {
    return (
      (this.attachedClientCounts.get(terminalSessionId) ?? 0) === 0 &&
      !this.recoveringSessionIds.has(terminalSessionId)
    );
  }
}
