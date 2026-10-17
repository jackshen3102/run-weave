import {
  bindRuntimeStatusReportToNode,
  expireRuntimeStatusReport,
  disableRuntimeStatusReport,
  type RuntimeNodeStatusSnapshot,
  type RuntimeStatusReport,
} from "@runweave/shared/runtime-status";
import { readLocalServiceReports } from "./local-services";
import { configuration } from "@runweave/config-node";

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
    const feishu = configuration();
    const feishuEnabled = ["node", "hub"].includes(String(feishu.get("services.feishu.role"))) ||
      ["appId", "appSecret", "node.url", "node.token"].some(field => Boolean(feishu.get(`services.feishu.${field}`)));
    const appServerDisabled = configuration().get("appServer.discovery") === "disabled" || ownedReports.some(report =>
      report?.source.id === "backend" && report.items.some(item => item.id === "backend.app-server-event-consumer" && item.state === "disabled"));
    const externalReports = [...this.externalReports.values()].map((stored) => {
      if ((stored.report.source.id === "feishu-bridge" && !feishuEnabled) || (stored.report.source.id === "app-server" && appServerDisabled)) return disableRuntimeStatusReport(stored.report);
      return expireRuntimeStatusReport(stored.report, stored.receivedAt, now);
    });
    if (!this.externalReports.has("feishu-bridge")) {
      externalReports.push({
        protocolVersion: 1,
        target: { kind: "node", nodeId: this.serviceInstanceId },
        source: {
          id: "feishu-bridge",
          runtime: "feishu-bridge",
          instanceId: "feishu-bridge:unreported",
          capabilityId: "feishu",
        },
        observedAt: now,
        validForMs: 15_000,
        items: [
          {
            id: "feishu.bridge-report",
            capabilityId: "feishu",
            label: "飞书 Bridge",
            state: feishuEnabled ? "blocked" : "disabled",
            summary: feishuEnabled ? "飞书已启用，但尚未收到 Bridge 状态，请检查配置及服务是否已启动" : "飞书未启用，不检查健康状态",
            observedAt: now,
            dependsOn: ["backend.process"],
            recovery: null,
            facts: [],
            navigation: null,
          },
        ],
      });
    }
    if (appServerDisabled && !this.externalReports.has("app-server")) {
      externalReports.push({ protocolVersion: 1, target: { kind: "node", nodeId: this.serviceInstanceId },
        source: { id: "app-server", runtime: "app-server", instanceId: "app-server:disabled", capabilityId: "app-server" },
        observedAt: now, validForMs: 15_000, items: [{ id: "app-server.source", capabilityId: "app-server", label: "App Server", state: "disabled",
          summary: "App Server 集成未启用，不检查健康状态", observedAt: now, dependsOn: [], recovery: null, facts: [], navigation: null }] });
    }
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
        ...readLocalServiceReports(now),
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
