import { CONFIGURATION_FIELDS } from "../configuration/fields";
import {
  aggregateRuntimeStatusCapabilities,
  runtimeStatusItemAttention,
  type RuntimeNodeStatusSnapshot,
  type RuntimeStatusAttention,
  type RuntimeStatusCapabilityId,
  type RuntimeStatusReport,
  type RuntimeStatusState,
} from "./runtime-status";

const domains: Readonly<Record<RuntimeStatusCapabilityId, readonly string[]>> = {
  node: ["backend.server", "backend.auth", "backend.tunnelAuth", "storage", "logging"],
  terminal: ["terminal", "agents.codex", "agents.traex", "services.snapshotPublisher", "voice"],
  feishu: ["services.feishu"],
  "app-server": ["appServer"],
  "workspace-services": [],
  desktop: ["desktop.browser", "desktop.tunnels", "agents.companion"],
  "background-tasks": ["scheduledTasks", "knowledge"],
  "research-mcp": ["backend.tunnelAuth", "desktop.tunnels"],
};

const ownerDomains: Partial<Record<RuntimeStatusReport["source"]["runtime"], readonly string[]>> = {
  "snapshot-host": ["services.snapshotHost"], "push-gateway": ["services.pushGateway"],
  "suiji-server": ["services.suiji"], "remote-desktop-host": [],
};

export interface ServiceDiagnostic {
  itemId: string;
  sourceId: string;
  attention: RuntimeStatusAttention;
  dependsOn: string[];
  configuration: { relationship: "candidate"; domains: readonly string[]; fieldPatterns: string[] };
  /** Read-only actions. Associations are investigation hints, never repair authorization. */
  actions: readonly ("config.keys" | "config.explain" | "config.validate" | "config.status" | "status")[];
}

export interface ServiceManagementSnapshot extends RuntimeNodeStatusSnapshot {
  management: {
    coverage: { scope: "backend-node"; snapshotRuntimes: string[]; excludes: readonly string[] };
    services: ManagedRuntimeService[];
    capabilities: ReturnType<typeof aggregateRuntimeStatusCapabilities>;
    diagnostics: ServiceDiagnostic[];
  };
}

export interface ManagedRuntimeService {
  id: string; label: string; sourceId: string; state: RuntimeStatusState; summary: string;
  observedAt: number | null; version: string | null;
  installation: "current" | "restart-required" | "unknown";
}

const SERVICE_CATALOG = [
  ["backend.process", "Backend", "backend"], ["app-server.process", "App Server", "app-server"],
  ["electron.process", "Desktop", "electron"], ["backend.cli-version", "CLI（节点 rw）", "backend"],
  ["feishu.bridge-lease", "飞书 Bridge", "feishu-bridge"], ["research-mcp.process", "调查 MCP", "research-mcp"],
  ["snapshot-host.process", "快照分享 Host", "snapshot-host"], ["push-gateway.process", "推送网关", "push-gateway"],
  ["suiji-server.process", "随记服务", "suiji-server"], ["remote-desktop-host.process", "RemoteDesk Host", "remote-desktop-host"],
] as const;

/** The same inventory is consumed by the panel and CLI, including explicit missing sources. */
export function runtimeServiceInventory(reports: readonly RuntimeStatusReport[]): ManagedRuntimeService[] {
  const normalized = new Map(aggregateRuntimeStatusCapabilities(reports).flatMap(capability => capability.items.map(item => [item.id, item] as const)));
  const definitions: Array<readonly [string, string, string]> = [...SERVICE_CATALOG];
  for (const report of reports) for (const item of report.items) {
    if (item.capabilityId === "workspace-services" || /^electron\.(cdp-proxy|companion|whistle:|remote-access:|remote-desktop:)/.test(item.id) || /^remote-desktop-host\.(listener|screen-permission|control-permission)$/.test(item.id)) definitions.push([item.id, item.label, report.source.id]);
  }
  return definitions.map(([id, label, sourceId]) => {
    const report = reports.find(entry => entry.source.id === sourceId);
    const item = normalized.get(`${sourceId}.source`) ?? normalized.get(id) ?? report?.items.find(entry => entry.id.endsWith("-report"));
    const installation = item?.facts.find(fact => fact.id === "runtime-installation.state")?.value;
    return { id, label, sourceId, state: item?.state ?? "unsupported", summary: item?.summary ?? "未收到此服务的健康报告；未启动、未安装和旧版本无法据此区分",
      observedAt: item?.observedAt ?? null, version: (normalized.get(id) ?? item)?.facts.find(fact => fact.id === "runtime-version.number")?.value ?? null,
      installation: item?.state === "healthy" && (installation === "current" || installation === "restart-required") ? installation : "unknown" };
  });
}

/** Consume existing owner reports; do not infer health from configuration or probe processes. */
export function serviceManagementSnapshot(snapshot: RuntimeNodeStatusSnapshot): ServiceManagementSnapshot {
  const capabilities = aggregateRuntimeStatusCapabilities(snapshot.reports);
  const normalized = new Map(capabilities.flatMap(capability => capability.items.map(item => [item.id, item] as const)));
  return {
    ...snapshot,
    management: {
      coverage: { scope: "backend-node", snapshotRuntimes: [...new Set(snapshot.reports.map(report => report.source.runtime))], excludes: ["frontend", "other-instances", "unmanaged-services", "cloud-services"] },
      services: runtimeServiceInventory(snapshot.reports),
      capabilities,
      diagnostics: snapshot.reports.flatMap(report => report.items.map(original => {
        const item = normalized.get(original.id) ?? original;
        const related = ownerDomains[report.source.runtime] ?? domains[item.capabilityId];
        return {
          itemId: item.id, sourceId: report.source.id,
          attention: runtimeStatusItemAttention(item.capabilityId, item.state), dependsOn: item.dependsOn,
          configuration: { relationship: "candidate" as const, domains: related, fieldPatterns: CONFIGURATION_FIELDS.filter(field => related.includes(field.domain)).map(field => field.path) },
          actions: ["config.keys", "config.explain", "config.validate", "config.status", "status"] as const,
        };
      })),
    },
  };
}
