import {
  aggregateRuntimeStatusCapabilities,
  aggregateRuntimeStatusState,
  bindRuntimeStatusReportToNode,
  normalizeRuntimeStatusId,
  type RuntimeNodeStatusSnapshot,
  type RuntimeStatusCapabilitySnapshot,
  type RuntimeStatusItem,
  type RuntimeStatusReport,
  type RuntimeStatusState,
} from "@runweave/shared/runtime-status";
import type { BackendHealthResult, BackendRuntimeStatusResult } from "../../services/runtime-status";

export type RuntimeStatusNodeRole = "local" | "current";

export interface RuntimeStatusEndpointResult {
  endpointKey: string;
  apiBase: string;
  address: string;
  roles: RuntimeStatusNodeRole[];
  health: BackendHealthResult;
  status: BackendRuntimeStatusResult | { kind: "missing-auth" };
  lastSnapshot: RuntimeNodeStatusSnapshot | null;
  failureSince: number | null;
  failureCount: number;
  observedAt: number;
}

export interface RuntimeStatusNodeView {
  id: string;
  serviceInstanceId: string | null;
  address: string;
  roles: RuntimeStatusNodeRole[];
  reports: RuntimeStatusReport[];
  capabilities: RuntimeStatusCapabilitySnapshot[];
  state: RuntimeStatusState;
  unhealthyCapabilityCount: number;
  generatedAt: number;
}

const FRONTEND_REPORT_VALID_FOR_MS = 15_000;

function statusSummary(kind: RuntimeStatusEndpointResult["status"]["kind"]): string {
  switch (kind) {
    case "missing-auth":
      return "当前节点没有可用登录会话";
    case "unauthorized":
      return "当前登录会话已失效";
    case "unsupported":
      return "当前 Backend 版本不支持详细运行状态";
    case "timeout":
      return "详细运行状态请求超时";
    case "network":
      return "详细运行状态暂时不可用";
    case "ok":
      return "详细运行状态可用";
  }
}

function buildFrontendReport(
  endpoint: RuntimeStatusEndpointResult,
  nodeId: string,
): RuntimeStatusReport {
  const httpState: RuntimeStatusState =
    endpoint.health.kind === "ok"
      ? "healthy"
      : endpoint.failureCount >= 2 ||
          (endpoint.failureSince !== null &&
            endpoint.observedAt - endpoint.failureSince >= 10_000)
        ? "unhealthy"
        : "recovering";
  const statusState: RuntimeStatusState =
    endpoint.status.kind === "ok"
      ? "healthy"
      : endpoint.status.kind === "unauthorized"
        ? "unhealthy"
        : endpoint.status.kind === "unsupported"
          ? "unsupported"
          : endpoint.status.kind === "missing-auth"
            ? "blocked"
            : "recovering";
  const recoveryStartedAt = endpoint.failureSince ?? endpoint.observedAt;
  const items: RuntimeStatusItem[] = [
    {
      id: "frontend.node.http",
      capabilityId: "node",
      label: "节点连接",
      state: httpState,
      summary:
        httpState === "healthy"
          ? "Backend HTTP 可用"
          : httpState === "recovering"
            ? "Backend HTTP 正在恢复"
            : "Backend HTTP 持续不可达",
      observedAt: endpoint.observedAt,
      dependsOn: [],
      recovery:
        httpState === "healthy"
          ? null
          : {
              startedAt: recoveryStartedAt,
              attempt: endpoint.failureCount,
              maxAttempts: 2,
              nextAttemptAt: null,
              deadlineAt: recoveryStartedAt + 10_000,
            },
      facts: [
        {
          id: "frontend.node.address",
          label: "连接地址",
          value: endpoint.address,
          kind: "address",
          copyable: true,
        },
      ],
      navigation: null,
    },
    {
      id: "frontend.node.auth",
      capabilityId: "node",
      label: "节点鉴权",
      state: statusState,
      summary: statusSummary(endpoint.status.kind),
      observedAt: endpoint.observedAt,
      dependsOn: ["frontend.node.http"],
      recovery: null,
      facts: [],
      navigation: null,
    },
  ];

  return {
    protocolVersion: 1,
    target: { kind: "node", nodeId },
    source: {
      id: "frontend",
      runtime: "frontend",
      instanceId: "frontend:renderer",
      capabilityId: "node",
    },
    observedAt: endpoint.observedAt,
    validForMs: FRONTEND_REPORT_VALID_FOR_MS,
    items,
  };
}

function bindBackendReports(
  snapshot: RuntimeNodeStatusSnapshot | null,
  nodeId: string,
): RuntimeStatusReport[] {
  if (!snapshot) return [];
  return snapshot.reports.map((report) =>
    bindRuntimeStatusReportToNode(
      {
        ...report,
        items: report.items.map((item) => ({
          ...item,
          dependsOn: Array.from(
            new Set([
              "frontend.node.http",
              "frontend.node.auth",
              ...item.dependsOn,
            ]),
          ),
        })),
      },
      nodeId,
    ),
  );
}

function mergeReports(
  current: RuntimeStatusReport[],
  incoming: RuntimeStatusReport[],
): RuntimeStatusReport[] {
  const bySource = new Map(current.map((report) => [report.source.id, report]));
  for (const report of incoming) {
    const existing = bySource.get(report.source.id);
    if (!existing) {
      bySource.set(report.source.id, report);
      continue;
    }
    const items = new Map(existing.items.map((item) => [item.id, item]));
    for (const item of report.items) items.set(item.id, item);
    bySource.set(report.source.id, {
      ...(report.observedAt >= existing.observedAt ? report : existing),
      items: [...items.values()],
    });
  }
  return [...bySource.values()];
}

function localAddressFromReport(report: RuntimeStatusReport | null): string | null {
  const fact = report?.items
    .flatMap((item) => item.facts)
    .find((candidate) => candidate.id === "electron.local-network.primary");
  return fact?.value ?? null;
}

export function buildRuntimeStatusNodes(input: {
  endpoints: RuntimeStatusEndpointResult[];
  electronReport: RuntimeStatusReport | null;
  frontendItems: RuntimeStatusItem[];
}): RuntimeStatusNodeView[] {
  const nodes = new Map<string, RuntimeStatusNodeView>();

  for (const endpoint of input.endpoints) {
    const currentSnapshot =
      endpoint.status.kind === "ok"
        ? endpoint.status.snapshot
        : endpoint.lastSnapshot;
    const serviceInstanceId =
      endpoint.health.kind === "ok"
        ? (endpoint.health.payload.serviceInstanceId ??
          currentSnapshot?.node.serviceInstanceId ??
          null)
        : (currentSnapshot?.node.serviceInstanceId ?? null);
    const nodeId = serviceInstanceId ?? `connection:${normalizeRuntimeStatusId(endpoint.address)}`;
    const frontendReport = buildFrontendReport(endpoint, nodeId);
    const backendReports = bindBackendReports(currentSnapshot, nodeId);
    const existing = nodes.get(nodeId);
    const reports = mergeReports(
      existing?.reports ?? [],
      [frontendReport, ...backendReports],
    );
    nodes.set(nodeId, {
      id: nodeId,
      serviceInstanceId,
      address:
        endpoint.roles.includes("current") || !existing
          ? endpoint.address
          : existing.address,
      roles: Array.from(new Set([...(existing?.roles ?? []), ...endpoint.roles])),
      reports,
      capabilities: [],
      state: "checking",
      unhealthyCapabilityCount: 0,
      generatedAt: endpoint.observedAt,
    });
  }

  let localNode = [...nodes.values()].find((node) => node.roles.includes("local"));
  if (!localNode && input.electronReport) {
    const nodeId = "local-host";
    localNode = {
      id: nodeId,
      serviceInstanceId: null,
      address: localAddressFromReport(input.electronReport) ?? "仅本机可用",
      roles: ["local"],
      reports: [],
      capabilities: [],
      state: "checking",
      unhealthyCapabilityCount: 0,
      generatedAt: input.electronReport.observedAt,
    };
    nodes.set(nodeId, localNode);
  }

  if (localNode && input.electronReport) {
    const localEndpoint = input.endpoints.find((endpoint) =>
      endpoint.roles.includes("local"),
    );
    const electronReport =
      localEndpoint && localEndpoint.health.kind !== "ok"
        ? {
            ...input.electronReport,
            items: input.electronReport.items.map((item) =>
              item.id === "electron.packaged-backend"
                ? {
                    ...item,
                    state: "blocked" as const,
                    summary: "节点连接不可用，Backend 状态由上游根因表达",
                    dependsOn: Array.from(
                      new Set(["frontend.node.http", ...item.dependsOn]),
                    ),
                    recovery: null,
                  }
                : item,
            ),
          }
        : input.electronReport;
    localNode.reports = mergeReports(localNode.reports, [
      bindRuntimeStatusReportToNode(electronReport, localNode.id),
    ]);
    localNode.address =
      localAddressFromReport(input.electronReport) ?? "仅本机可用";
    localNode.generatedAt = Math.max(
      localNode.generatedAt,
      input.electronReport.observedAt,
    );
  }

  const currentNode = [...nodes.values()].find((node) =>
    node.roles.includes("current"),
  );
  if (currentNode && input.frontendItems.length > 0) {
    const report: RuntimeStatusReport = {
      protocolVersion: 1,
      target: { kind: "node", nodeId: currentNode.id },
      source: {
        id: "frontend-live",
        runtime: "frontend",
        instanceId: "frontend-live",
        capabilityId: "terminal",
      },
      observedAt: Math.max(...input.frontendItems.map((item) => item.observedAt)),
      validForMs: FRONTEND_REPORT_VALID_FOR_MS,
      items: input.frontendItems,
    };
    currentNode.reports = mergeReports(currentNode.reports, [report]);
  }

  return [...nodes.values()].map((node) => {
    const capabilities = aggregateRuntimeStatusCapabilities(node.reports);
    return {
      ...node,
      capabilities,
      state: aggregateRuntimeStatusState(
        capabilities.map((capability) => capability.state),
      ),
      unhealthyCapabilityCount: capabilities.filter(
        (capability) => capability.unhealthy,
      ).length,
    };
  });
}
