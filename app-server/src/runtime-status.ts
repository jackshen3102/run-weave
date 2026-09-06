import type { RuntimeStatusReport } from "@runweave/shared/runtime-status";
import type { AppServerEventCenter } from "./events/center.js";
import type { AgentThreadStatusReconciler } from "./state/reconciler.js";

export function createAppServerRuntimeStatusReport(options: {
  eventCenter: AppServerEventCenter;
  reconciler: AgentThreadStatusReconciler;
  serviceInstanceId: string;
  version: string;
  now?: number;
}): RuntimeStatusReport {
  const now = options.now ?? Date.now();
  const sync = options.eventCenter.getSyncStatus();
  const reconciler = options.reconciler.getStatusSnapshot();
  const reconciliationFresh =
    reconciler.lastCompletedAt !== null &&
    now - reconciler.lastCompletedAt <= reconciler.intervalMs * 3;
  const reconciliationState =
    reconciler.consecutiveFailures >= 3 ||
    (!reconciliationFresh &&
      now - reconciler.startedAt >
        reconciler.startDelayMs + reconciler.intervalMs * 3)
      ? "unhealthy"
      : reconciler.running || reconciliationFresh
        ? "healthy"
        : "recovering";

  return {
    protocolVersion: 1,
    target: { kind: "local-host" },
    source: {
      id: "app-server",
      runtime: "app-server",
      instanceId: options.serviceInstanceId,
      capabilityId: "app-server",
    },
    observedAt: now,
    validForMs: 15_000,
    items: [
      {
        id: "app-server.process",
        capabilityId: "app-server",
        label: "App Server process",
        state: "healthy",
        summary: "App Server 已就绪",
        observedAt: now,
        dependsOn: [],
        recovery: null,
        facts: [
          {
            id: "app-server.version",
            label: "版本",
            value: options.version,
            kind: "text",
            copyable: true,
          },
        ],
        navigation: null,
      },
      {
        id: "app-server.event-center",
        capabilityId: "app-server",
        label: "Event Center",
        state: "healthy",
        summary: "事件存储与状态投影已就绪",
        observedAt: now,
        dependsOn: ["app-server.process"],
        recovery: null,
        facts: [],
        navigation: null,
      },
      {
        id: "app-server.cloud-sync",
        capabilityId: "app-server",
        label: "Cloud sync",
        state: sync.lastError ? "unhealthy" : "healthy",
        summary: sync.lastError
          ? "Cloud sync 最近一次同步失败"
          : "Cloud sync 正常",
        observedAt: sync.lastSyncAt ? Date.parse(sync.lastSyncAt) : now,
        dependsOn: ["app-server.process"],
        recovery: null,
        facts: [],
        navigation: null,
      },
      {
        id: "app-server.thread-reconciler",
        capabilityId: "app-server",
        label: "Thread reconciler",
        state: reconciliationState,
        summary:
          reconciliationState === "healthy"
            ? "Reconciler 周期正常"
            : reconciliationState === "recovering"
              ? "等待 Reconciler 完成"
              : "Reconciler 已超过三个周期未完成",
        observedAt:
          reconciler.lastCompletedAt ??
          reconciler.lastStartedAt ??
          reconciler.startedAt,
        dependsOn: ["app-server.process", "app-server.event-center"],
        recovery:
          reconciliationState === "recovering"
            ? {
                startedAt: reconciler.lastStartedAt ?? reconciler.startedAt,
                attempt: null,
                maxAttempts: null,
                nextAttemptAt: null,
                deadlineAt:
                  reconciler.startedAt +
                  reconciler.startDelayMs +
                  reconciler.intervalMs * 3,
              }
            : null,
        facts: [],
        navigation: null,
      },
    ],
  };
}
