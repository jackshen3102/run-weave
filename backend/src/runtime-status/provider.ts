import type {
  RuntimeStatusItem,
  RuntimeStatusReport,
  RuntimeStatusState,
} from "@runweave/shared/runtime-status";
import type { AgentTeamRecheckWatchdogStatus } from "../agent-team/service/recheck";
import type { AppServerEventConsumerStatusSnapshot } from "../app-server/event-consumer";
import type { EvolutionRuntime } from "../evolution/runtime";
import type { RuntimeStatusWorkspaceServiceManager } from "./workspace-service-manager";

const BACKEND_REPORT_VALID_FOR_MS = 15_000;

export interface AppServerIntegrationStatus {
  state: "checking" | "disabled" | "unconfigured" | "unhealthy";
  summary: string;
  observedAt: number;
}

export interface BackendRuntimeStatusInput {
  serviceInstanceId: string;
  listener: { baseUrl: string; host: string; port: number } | null;
  activityStoreAvailable: boolean;
  eventConsumer: AppServerEventConsumerStatusSnapshot | null;
  appServerIntegration: AppServerIntegrationStatus;
  watchdog: AgentTeamRecheckWatchdogStatus;
  evolution: ReturnType<EvolutionRuntime["getStatusSnapshot"]>;
  workspaceServiceManager: RuntimeStatusWorkspaceServiceManager;
}

export async function createBackendRuntimeStatusReport(
  services: BackendRuntimeStatusInput,
  now = Date.now(),
): Promise<RuntimeStatusReport> {
  const listener = services.listener;
  const items: RuntimeStatusItem[] = [
    {
      id: "backend.process",
      capabilityId: "node",
      label: "Backend process",
      state: listener ? "healthy" : "checking",
      summary: listener ? "Backend 正在监听" : "Backend 正在启动",
      observedAt: now,
      dependsOn: [],
      recovery: null,
      facts: listener
        ? [
            {
              id: "backend.address",
              label: "地址",
              value: listener.baseUrl,
              kind: "address",
              copyable: true,
            },
            {
              id: "backend.port",
              label: "端口",
              value: String(listener.port),
              kind: "port",
              copyable: true,
            },
          ]
        : [],
      navigation: null,
    },
    {
      id: "backend.activity-store",
      capabilityId: "background-tasks",
      label: "Activity store",
      state: services.activityStoreAvailable ? "healthy" : "unhealthy",
      summary: services.activityStoreAvailable
        ? "Activity store 已初始化"
        : "Activity store 初始化失败",
      observedAt: now,
      dependsOn: ["backend.process"],
      recovery: null,
      facts: [],
      navigation: { label: "Activity", route: "/activity" },
    },
    buildEventConsumerItem(services.eventConsumer, services.appServerIntegration, now),
    buildWatchdogItem(services.watchdog, now),
    buildEvolutionItem(services.evolution, now),
    ...(await services.workspaceServiceManager.getRuntimeStatusItems(now)),
  ];

  return {
    protocolVersion: 1,
    target: { kind: "node", nodeId: services.serviceInstanceId },
    source: {
      id: "backend",
      runtime: "backend",
      instanceId: services.serviceInstanceId,
      capabilityId: "node",
    },
    observedAt: now,
    validForMs: BACKEND_REPORT_VALID_FOR_MS,
    items,
  };
}

function buildEventConsumerItem(
  snapshot: AppServerEventConsumerStatusSnapshot | null,
  integration: AppServerIntegrationStatus,
  now: number,
): RuntimeStatusItem {
  if (!snapshot) {
    return statusItem(
      "backend.app-server-event-consumer",
      "app-server",
      "App Server event consumer",
      integration.state,
      integration.summary,
      integration.observedAt,
    );
  }
  const elapsed = snapshot.failureSince
    ? Math.max(0, now - snapshot.failureSince)
    : 0;
  const state: RuntimeStatusState =
    snapshot.state === "connected"
      ? "healthy"
      : snapshot.state === "stopped"
        ? "disabled"
        : snapshot.failureSince && elapsed >= 60_000
          ? "unhealthy"
          : "recovering";
  return {
    ...statusItem(
      "backend.app-server-event-consumer",
      "app-server",
      "App Server event consumer",
      state,
      state === "healthy"
        ? "事件流已连接"
        : state === "unhealthy"
          ? "事件流持续断开"
          : state === "disabled"
            ? "事件消费已停止"
            : "事件流正在重连",
      snapshot.observedAt,
    ),
    recovery:
      state === "recovering" || state === "unhealthy"
        ? {
            startedAt: snapshot.failureSince ?? snapshot.observedAt,
            attempt: snapshot.reconnectAttempt,
            maxAttempts: null,
            nextAttemptAt: snapshot.nextAttemptAt,
            deadlineAt: (snapshot.failureSince ?? snapshot.observedAt) + 60_000,
          }
        : null,
  };
}

function buildWatchdogItem(
  snapshot: AgentTeamRecheckWatchdogStatus,
  now: number,
): RuntimeStatusItem {
  const fresh =
    snapshot.lastCompletedAt !== null &&
    now - snapshot.lastCompletedAt <= 30_000;
  const withinStartup = now - snapshot.startedAt <= 30_000;
  const state: RuntimeStatusState =
    snapshot.consecutiveFailures >= 3
      ? "unhealthy"
      : (snapshot.running &&
            snapshot.lastStartedAt !== null &&
            now - snapshot.lastStartedAt <= 30_000) ||
          fresh
        ? "healthy"
        : snapshot.lastCompletedAt === null && withinStartup
          ? "recovering"
          : "unhealthy";
  return statusItem(
    "backend.agent-team-recheck-watchdog",
    "background-tasks",
    "Agent Team watchdog",
    state,
    state === "healthy"
      ? "Watchdog 周期正常"
      : state === "recovering"
        ? "等待首轮 Watchdog 完成"
        : "Watchdog 已超过三个周期未完成",
    snapshot.lastCompletedAt ?? snapshot.lastStartedAt ?? snapshot.startedAt,
  );
}

function buildEvolutionItem(
  snapshot: ReturnType<EvolutionRuntime["getStatusSnapshot"]>,
  now: number,
): RuntimeStatusItem {
  if (!snapshot.enabled) {
    return statusItem(
      "backend.evolution-maintenance",
      "background-tasks",
      "Evolution maintenance",
      "disabled",
      "Evolution store 未启用",
      now,
    );
  }
  const freshnessAt = snapshot.activeExecution
    ? snapshot.lastLeaseHeartbeatAt
    : snapshot.lastMaintenanceCompletedAt;
  const fresh = freshnessAt !== null && now - freshnessAt <= 15_000;
  const state: RuntimeStatusState =
    snapshot.consecutiveMaintenanceFailures >= 3
      ? "unhealthy"
      : fresh || snapshot.maintenanceRunning
        ? "healthy"
        : snapshot.lastMaintenanceCompletedAt === null &&
            now - snapshot.startedAt <= 15_000
          ? "recovering"
          : "unhealthy";
  return statusItem(
    "backend.evolution-maintenance",
    "background-tasks",
    "Evolution maintenance",
    state,
    snapshot.activeExecution
      ? state === "healthy"
        ? "Evolution run lease 正常"
        : "Evolution run lease 已过期"
      : state === "healthy"
        ? "Maintenance 周期正常"
        : state === "recovering"
          ? "等待首轮 maintenance"
          : "Maintenance 已超过三个周期未完成",
    freshnessAt ?? snapshot.lastMaintenanceStartedAt ?? snapshot.startedAt,
  );
}

function statusItem(
  id: string,
  capabilityId: RuntimeStatusItem["capabilityId"],
  label: string,
  state: RuntimeStatusState,
  summary: string,
  observedAt: number,
): RuntimeStatusItem {
  return {
    id,
    capabilityId,
    label,
    state,
    summary,
    observedAt,
    dependsOn: ["backend.process"],
    recovery: null,
    facts: [],
    navigation: null,
  };
}
