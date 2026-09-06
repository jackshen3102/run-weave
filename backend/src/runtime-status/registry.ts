import {
  bindRuntimeStatusReportToNode,
  expireRuntimeStatusReport,
  type RuntimeNodeStatusSnapshot,
  type RuntimeStatusReport,
} from "@runweave/shared/runtime-status";

export type RuntimeStatusProvider = () =>
  | RuntimeStatusReport
  | Promise<RuntimeStatusReport>;

interface StoredExternalReport {
  report: RuntimeStatusReport;
  receivedAt: number;
}

export class RuntimeStatusRegistry {
  private readonly providers = new Map<string, RuntimeStatusProvider>();
  private readonly providerReports = new Map<string, StoredExternalReport>();
  private readonly externalReports = new Map<string, StoredExternalReport>();
  private disposed = false;

  constructor(readonly serviceInstanceId: string) {}

  registerProvider(id: string, provider: RuntimeStatusProvider): () => void {
    if (this.disposed) throw new Error("Runtime status registry is disposed");
    this.providers.set(id, provider);
    return () => {
      if (this.providers.get(id) === provider) this.providers.delete(id);
    };
  }

  setExternalReport(
    report: RuntimeStatusReport,
    receivedAt = Date.now(),
  ): void {
    if (this.disposed) return;
    const bound = bindRuntimeStatusReportToNode(report, this.serviceInstanceId);
    this.externalReports.set(bound.source.id, {
      report: { ...bound, observedAt: receivedAt },
      receivedAt,
    });
  }

  async getSnapshot(now = Date.now()): Promise<RuntimeNodeStatusSnapshot> {
    const ownedReports = await Promise.all(
      [...this.providers.entries()].map(async ([id, provider]) => {
        try {
          const report = await provider();
          this.providerReports.set(id, { report, receivedAt: now });
          return report;
        } catch {
          const stored = this.providerReports.get(id);
          return stored
            ? expireRuntimeStatusReport(stored.report, stored.receivedAt, now)
            : null;
        }
      }),
    );
    const externalReports = [...this.externalReports.values()].map((stored) =>
      expireRuntimeStatusReport(stored.report, stored.receivedAt, now),
    );
    return {
      protocolVersion: 1,
      generatedAt: now,
      node: {
        id: this.serviceInstanceId,
        serviceInstanceId: this.serviceInstanceId,
      },
      reports: [
        ...ownedReports.filter((report) => report !== null),
        ...externalReports,
      ].map((report) =>
        bindRuntimeStatusReportToNode(report, this.serviceInstanceId),
      ),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.providers.clear();
    this.providerReports.clear();
    this.externalReports.clear();
  }
}
