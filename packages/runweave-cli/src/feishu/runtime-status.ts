import { randomUUID } from "node:crypto";
import type {
  RuntimeStatusItem,
  RuntimeStatusReport,
  RuntimeStatusState,
} from "@runweave/shared/runtime-status";
import type { AuthContext } from "../client/auth-context.js";

const REPORT_INTERVAL_MS = 5_000;
const LARK_FAILURE_GRACE_MS = 120_000;
const BACKEND_FAILURE_GRACE_MS = 30_000;

interface ConnectionObservation {
  connected: boolean;
  observedAt: number;
  failureSince: number | null;
  attempt: number;
}

export class FeishuRuntimeStatusReporter {
  private readonly instanceId = `feishu-bridge:${process.pid}:${randomUUID()}`;
  private readonly startedAt = Date.now();
  private leaseHeld = true;
  private lark: ConnectionObservation = {
    connected: false,
    observedAt: Date.now(),
    failureSince: Date.now(),
    attempt: 0,
  };
  private backend: ConnectionObservation = {
    connected: false,
    observedAt: Date.now(),
    failureSince: Date.now(),
    attempt: 0,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly auth: AuthContext) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.publish().catch(() => undefined),
      REPORT_INTERVAL_MS,
    );
    this.timer.unref?.();
    void this.publish().catch(() => undefined);
  }

  markLarkConnected(): void {
    this.lark = connectedObservation();
  }

  markLarkDisconnected(): void {
    this.lark = failedObservation(this.lark);
  }

  markBackendConnected(): void {
    this.backend = connectedObservation();
  }

  markBackendDisconnected(): void {
    this.backend = failedObservation(this.backend);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
    this.leaseHeld = false;
    await this.publish().catch(() => undefined);
  }

  publish(): Promise<void> {
    this.inFlight ??= this.auth
      .requestVoid("/api/runtime-status/reports/feishu-bridge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.buildReport()),
        signal: AbortSignal.timeout(5_000),
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  buildReport(now = Date.now()): RuntimeStatusReport {
    return {
      protocolVersion: 1,
      target: { kind: "local-host" },
      source: {
        id: "feishu-bridge",
        runtime: "feishu-bridge",
        instanceId: this.instanceId,
        capabilityId: "feishu",
      },
      observedAt: now,
      validForMs: 15_000,
      items: [
        baseItem(
          "feishu.configuration",
          "Configuration",
          "healthy",
          "飞书 Bridge 配置有效",
          now,
        ),
        baseItem(
          "feishu.bridge-lease",
          "Bridge lease",
          this.leaseHeld ? "healthy" : "disabled",
          this.leaseHeld ? "已取得单实例 lease" : "Bridge 正在停止",
          now,
        ),
        connectionItem(
          "feishu.lark-websocket",
          "Lark WebSocket",
          this.lark,
          LARK_FAILURE_GRACE_MS,
          now,
          ["feishu.configuration", "feishu.bridge-lease"],
        ),
        connectionItem(
          "feishu.backend-auth",
          "Backend auth",
          this.backend,
          BACKEND_FAILURE_GRACE_MS,
          now,
          ["feishu.configuration", "feishu.bridge-lease"],
        ),
      ],
    };
  }
}

function connectedObservation(): ConnectionObservation {
  return {
    connected: true,
    observedAt: Date.now(),
    failureSince: null,
    attempt: 0,
  };
}

function failedObservation(
  current: ConnectionObservation,
): ConnectionObservation {
  const now = Date.now();
  return {
    connected: false,
    observedAt: now,
    failureSince: current.failureSince ?? now,
    attempt: current.connected ? 1 : current.attempt + 1,
  };
}

function baseItem(
  id: string,
  label: string,
  state: RuntimeStatusState,
  summary: string,
  observedAt: number,
): RuntimeStatusItem {
  return {
    id,
    capabilityId: "feishu",
    label,
    state,
    summary,
    observedAt,
    dependsOn: [],
    recovery: null,
    facts: [],
    navigation: null,
  };
}

function connectionItem(
  id: string,
  label: string,
  observation: ConnectionObservation,
  graceMs: number,
  now: number,
  dependsOn: string[],
): RuntimeStatusItem {
  const state: RuntimeStatusState = observation.connected
    ? "healthy"
    : now - (observation.failureSince ?? now) >= graceMs
      ? "unhealthy"
      : "recovering";
  return {
    ...baseItem(
      id,
      label,
      state,
      state === "healthy"
        ? `${label} 已连接`
        : state === "unhealthy"
          ? `${label} 持续不可用`
          : `${label} 正在恢复`,
      observation.observedAt,
    ),
    dependsOn,
    recovery:
      state === "healthy"
        ? null
        : {
            startedAt: observation.failureSince ?? observation.observedAt,
            attempt: observation.attempt,
            maxAttempts: null,
            nextAttemptAt: null,
            deadlineAt:
              (observation.failureSince ?? observation.observedAt) + graceMs,
          },
  };
}
