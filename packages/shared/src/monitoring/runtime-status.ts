export const RUNTIME_STATUS_PROTOCOL_VERSION = 1 as const;

export const RUNTIME_STATUS_STATES = [
  "healthy",
  "recovering",
  "unhealthy",
  "blocked",
  "checking",
  "unconfigured",
  "disabled",
  "unsupported",
] as const;

export type RuntimeStatusState = (typeof RUNTIME_STATUS_STATES)[number];

export const RUNTIME_STATUS_CAPABILITY_IDS = [
  "node",
  "terminal",
  "feishu",
  "app-server",
  "workspace-services",
  "desktop",
  "background-tasks",
] as const;

export type RuntimeStatusCapabilityId =
  (typeof RUNTIME_STATUS_CAPABILITY_IDS)[number];

export interface RuntimeStatusRecovery {
  startedAt: number;
  attempt: number | null;
  maxAttempts: number | null;
  nextAttemptAt: number | null;
  deadlineAt: number | null;
}

export interface RuntimeStatusFact {
  id: string;
  label: string;
  value: string;
  kind: "address" | "port" | "text" | "time";
  copyable: boolean;
}

export interface RuntimeStatusNavigation {
  label: string;
  route: string;
}

export interface RuntimeStatusItem {
  id: string;
  capabilityId: RuntimeStatusCapabilityId;
  label: string;
  state: RuntimeStatusState;
  summary: string;
  observedAt: number;
  dependsOn: string[];
  recovery: RuntimeStatusRecovery | null;
  facts: RuntimeStatusFact[];
  navigation: RuntimeStatusNavigation | null;
}

export interface RuntimeStatusSource {
  id: string;
  runtime: "frontend" | "backend" | "electron" | "app-server" | "feishu-bridge";
  instanceId: string;
  capabilityId: RuntimeStatusCapabilityId;
}

export type RuntimeStatusTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "local-host" };

export interface RuntimeStatusReport {
  protocolVersion: 1;
  target: RuntimeStatusTarget;
  source: RuntimeStatusSource;
  observedAt: number;
  validForMs: number;
  items: RuntimeStatusItem[];
}

export interface RuntimeNodeStatusSnapshot {
  protocolVersion: 1;
  generatedAt: number;
  node: {
    id: string;
    serviceInstanceId: string;
  };
  reports: RuntimeStatusReport[];
}

export interface RuntimeStatusCapabilitySnapshot {
  capabilityId: RuntimeStatusCapabilityId;
  state: RuntimeStatusState;
  unhealthy: boolean;
  items: RuntimeStatusItem[];
}

export const RUNTIME_STATUS_CAPABILITY_ORDER: readonly RuntimeStatusCapabilityId[] =
  RUNTIME_STATUS_CAPABILITY_IDS;

const STATE_SEVERITY: Readonly<Record<RuntimeStatusState, number>> = {
  unsupported: 0,
  disabled: 1,
  unconfigured: 2,
  healthy: 3,
  blocked: 4,
  checking: 5,
  recovering: 6,
  unhealthy: 7,
};

export function isRuntimeStatusState(
  value: unknown,
): value is RuntimeStatusState {
  return (RUNTIME_STATUS_STATES as readonly unknown[]).includes(value);
}

export function isRuntimeStatusCapabilityId(
  value: unknown,
): value is RuntimeStatusCapabilityId {
  return (RUNTIME_STATUS_CAPABILITY_IDS as readonly unknown[]).includes(value);
}

export function aggregateRuntimeStatusState(
  states: readonly (RuntimeStatusState | string)[],
): RuntimeStatusState {
  let result: RuntimeStatusState = "unsupported";
  for (const candidate of states) {
    const state = isRuntimeStatusState(candidate) ? candidate : "unsupported";
    if (STATE_SEVERITY[state] > STATE_SEVERITY[result]) result = state;
  }
  return result;
}

export function isRuntimeStatusReportExpired(
  receivedAt: number,
  validForMs: number,
  now = Date.now(),
): boolean {
  return now - receivedAt > validForMs;
}

export function normalizeRuntimeStatusId(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.:]+|[-.:]+$/gu, "")
    .slice(0, 96);
  return normalized || "unknown";
}

export function bindRuntimeStatusReportToNode(
  report: RuntimeStatusReport,
  nodeId: string,
): RuntimeStatusReport {
  return {
    ...report,
    target: { kind: "node", nodeId },
    source: { ...report.source },
    items: report.items.map(cloneRuntimeStatusItem),
  };
}

export function expireRuntimeStatusReport(
  report: RuntimeStatusReport,
  receivedAt: number,
  now = Date.now(),
): RuntimeStatusReport {
  if (!isRuntimeStatusReportExpired(receivedAt, report.validForMs, now)) {
    return {
      ...report,
      source: { ...report.source },
      items: report.items.map(cloneRuntimeStatusItem),
    };
  }

  const sourceItemId = `${normalizeRuntimeStatusId(report.source.id)}.source`;
  const sourceItem: RuntimeStatusItem = {
    id: sourceItemId,
    capabilityId: report.source.capabilityId,
    label: "状态来源",
    state: "unhealthy",
    summary: "状态来源已过期",
    observedAt: receivedAt + report.validForMs,
    dependsOn: [],
    recovery: null,
    facts: [],
    navigation: null,
  };
  return {
    ...report,
    source: { ...report.source },
    items: [
      sourceItem,
      ...report.items.map((item) => ({
        ...cloneRuntimeStatusItem(item),
        state: "blocked" as const,
        summary: "状态来源不可用，保留最后已知结果",
        dependsOn: Array.from(new Set([sourceItemId, ...item.dependsOn])),
        recovery: null,
      })),
    ],
  };
}

export function suppressRuntimeStatusDependencies(
  items: readonly RuntimeStatusItem[],
): RuntimeStatusItem[] {
  const result = items.map(cloneRuntimeStatusItem);
  const byId = new Map(result.map((item) => [item.id, item]));
  for (let pass = 0; pass < result.length; pass += 1) {
    let changed = false;
    for (const item of result) {
      if (item.dependsOn.length === 0) continue;
      const unavailable = item.dependsOn.some((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return (
          !dependency ||
          dependency.state === "unhealthy" ||
          dependency.state === "blocked"
        );
      });
      if (unavailable && item.state !== "blocked") {
        item.state = "blocked";
        item.summary = "上游依赖不可用，暂时无法判断";
        item.recovery = null;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

export function aggregateRuntimeStatusCapabilities(
  reports: readonly RuntimeStatusReport[],
): RuntimeStatusCapabilitySnapshot[] {
  const items = suppressRuntimeStatusDependencies(
    reports.flatMap((report) => report.items),
  );
  return RUNTIME_STATUS_CAPABILITY_ORDER.flatMap((capabilityId) => {
    const capabilityItems = items.filter(
      (item) => item.capabilityId === capabilityId,
    );
    if (capabilityItems.length === 0) return [];
    const state = aggregateRuntimeStatusState(
      capabilityItems.map((item) => item.state),
    );
    return [
      {
        capabilityId,
        state,
        unhealthy: state === "unhealthy",
        items: capabilityItems,
      },
    ];
  });
}

function cloneRuntimeStatusItem(item: RuntimeStatusItem): RuntimeStatusItem {
  return {
    ...item,
    dependsOn: [...item.dependsOn],
    recovery: item.recovery ? { ...item.recovery } : null,
    facts: item.facts.map((fact) => ({ ...fact })),
    navigation: item.navigation ? { ...item.navigation } : null,
  };
}
