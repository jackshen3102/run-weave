import { CONFIGURATION_FIELDS } from "../configuration/fields";
import {
  aggregateRuntimeStatusCapabilities,
  runtimeStatusItemAttention,
  type RuntimeNodeStatusSnapshot,
  type RuntimeStatusAttention,
  type RuntimeStatusCapabilityId,
} from "./runtime-status";

const domains: Readonly<Record<RuntimeStatusCapabilityId, readonly string[]>> = {
  node: ["backend.server", "backend.auth", "backend.tunnelAuth", "storage", "logging"],
  terminal: ["terminal", "agents.codex", "agents.traex", "services.snapshotPublisher", "voice"],
  feishu: ["services.feishu"],
  "app-server": ["appServer"],
  "workspace-services": [],
  desktop: ["desktop.browser", "desktop.tunnels", "agents.companion"],
  "background-tasks": ["scheduledTasks", "agents.team", "knowledge"],
  "research-mcp": ["backend.tunnelAuth", "desktop.tunnels"],
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
    coverage: { scope: "backend-node"; snapshotRuntimes: string[]; excludes: readonly ["frontend", "electron-local-ipc", "unreported-services"] };
    capabilities: ReturnType<typeof aggregateRuntimeStatusCapabilities>;
    diagnostics: ServiceDiagnostic[];
  };
}

/** Consume existing owner reports; do not infer health from configuration or probe processes. */
export function serviceManagementSnapshot(snapshot: RuntimeNodeStatusSnapshot): ServiceManagementSnapshot {
  const capabilities = aggregateRuntimeStatusCapabilities(snapshot.reports);
  const normalized = new Map(capabilities.flatMap(capability => capability.items.map(item => [item.id, item] as const)));
  return {
    ...snapshot,
    management: {
      coverage: { scope: "backend-node", snapshotRuntimes: [...new Set(snapshot.reports.map(report => report.source.runtime))], excludes: ["frontend", "electron-local-ipc", "unreported-services"] },
      capabilities,
      diagnostics: snapshot.reports.flatMap(report => report.items.map(original => {
        const item = normalized.get(original.id) ?? original;
        const related = domains[item.capabilityId];
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
