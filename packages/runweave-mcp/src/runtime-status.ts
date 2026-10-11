import { runtimeBuildInfo, runtimeVersionFacts } from "@runweave/shared/runtime-version";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readResearchMcpInstallation, resolveConfigurationContext } from "@runweave/config-node";
import type { RuntimeStatusFact, RuntimeStatusItem, RuntimeStatusReport } from "@runweave/shared/runtime-status";
import type { Backend } from "./backend.js";

declare const __MCP_SOURCE_REVISION__: string;
declare const __MCP_RELEASE_ID__: string;
export const mcpIdentity = {
  sourceRevision: typeof __MCP_SOURCE_REVISION__ === "string" ? __MCP_SOURCE_REVISION__ : "unknown",
  releaseId: typeof __MCP_RELEASE_ID__ === "string" ? __MCP_RELEASE_ID__ : "unbundled",
};

function text(id: string, label: string, value: string): RuntimeStatusFact {
  return { id, label, value, kind: "text", copyable: true };
}
function time(id: string, label: string, value: number): RuntimeStatusFact {
  return { id, label, value: new Date(value).toISOString(), kind: "time", copyable: true };
}

export function createMcpRuntimeStatus(backend: Backend) {
  const context = resolveConfigurationContext();
  const instanceId = `research-mcp:${randomUUID()}`;
  const startedAt = Date.now();
  let lastToolSuccess: number | null = null;
  let items: RuntimeStatusItem[] = [];
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const failedSince = new Map<string, number>();
  const item = (id: string, label: string, failure: string | null, facts: RuntimeStatusFact[] = []): RuntimeStatusItem => {
    const now = Date.now();
    if (failure && !failedSince.has(id)) failedSince.set(id, now);
    if (!failure) failedSince.delete(id);
    const since = failedSince.get(id);
    const recovering = since !== undefined && now - since < 30_000;
    return { id, capabilityId: "research-mcp", label, state: failure ? recovering ? "recovering" : "unhealthy" : "healthy",
      summary: failure ?? "最近只读检查成功", observedAt: now, dependsOn: [], facts,
      recovery: recovering ? { startedAt: since!, attempt: null, maxAttempts: null, nextAttemptAt: now + 10_000, deadlineAt: since! + 30_000 } : null, navigation: null };
  };
  let lastActivitySuccess: number | null = null;
  let backendRevision = "unknown";
  let backendInstance = "unknown";
  const checkActivity = async (): Promise<RuntimeStatusItem> => {
    let failure: string | null = null;
    try {
      const health = await backend.get<{ sourceRevision?: string; sourceDirty?: boolean; serviceInstanceId?: string }>("/health", {}, 3000);
      backendRevision = `${health.sourceRevision ?? "unknown"}${health.sourceDirty ? "+dirty" : ""}`;
      backendInstance = health.serviceInstanceId ?? "unknown";
      const page = await backend.get<{ facts?: unknown[] }>("/api/activity/facts", { limit: 1 });
      if (!Array.isArray(page.facts)) throw new Error("invalid_activity_response");
      lastActivitySuccess = Date.now();
    } catch (error) {
      // Never publish credential-bearing request errors or arbitrary backend response bodies.
      const message = error instanceof Error ? error.message : "";
      failure = /401|403|auth|token/i.test(message) ? "Backend 鉴权失败，请修复当前实例的 rw 登录" : "Backend 或 Activity 查询不可用（不等于零条记录）";
    }
    return item("research-mcp.activity-read", "Activity 读取", failure, [
      text("backend-sha", "Backend 运行 SHA", backendRevision),
      text("backend-instance", "Backend 进程实例", backendInstance),
      ...(lastActivitySuccess ? [time("activity-success", "最近成功 Activity 查询", lastActivitySuccess)] : []),
    ]);
  };
  const checkTunnel = async (): Promise<RuntimeStatusItem> => {
    try {
      const installation = readResearchMcpInstallation();
      if (!installation?.tunnel) return { ...item("research-mcp.tunnel", "隧道转发", null), state: "unconfigured", summary: "尚未配置调查隧道；本地可用不代表云端可用" };
      const address = (await readFile(installation.tunnel.healthFile, "utf8")).trim();
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(address)) throw new Error("invalid_tunnel_health_address");
      const response = await fetch(`${address}/health?details=true`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      if (!response.ok) throw new Error("tunnel_health_unavailable");
      const health = await response.json() as {
        live?: boolean; ready?: boolean; components?: Record<string, { status?: string; details?: { last_success?: string; consecutive_failures?: number } }>;
      };
      const control = health.components?.["control-plane"];
      const success = Date.parse(control?.details?.last_success ?? "");
      const usable = health.live === true && health.ready === true && control?.status === "ok" && control.details?.consecutive_failures === 0 && Date.now() - success < 90_000 && health.components?.dispatcher?.status !== "degraded";
      return item("research-mcp.tunnel", "隧道转发", usable ? null : "隧道尚未就绪或控制面轮询失败", [
        text("tunnel-scope", "检查范围", "客户端与控制面；本次检查不是云端端到端调用"),
        ...(Number.isFinite(success) ? [time("control-success", "最近控制面成功轮询", success)] : []),
      ]);
    } catch { return item("research-mcp.tunnel", "隧道转发", "隧道状态不可读，请检查常驻隧道进程与 profile"); }
  };
  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= Promise.all([checkActivity(), checkTunnel()]).then((next) => { if (!stopped) items = next; }).finally(() => { inFlight = null; });
    return inFlight;
  };
  void poll();
  const timer = setInterval(() => void poll(), 10_000);
  timer.unref();
  return {
    toolSucceeded() { lastToolSuccess = Date.now(); },
    report(): RuntimeStatusReport {
      const now = Date.now();
      return { protocolVersion: 1, target: { kind: "local-host" }, source: { id: "research-mcp", runtime: "research-mcp", instanceId, capabilityId: "research-mcp" }, observedAt: now, validForMs: 20_000,
        items: [{ ...item("research-mcp.process", "本地服务", null, [
          ...runtimeVersionFacts(runtimeBuildInfo()),
          text("mcp-sha", "MCP 发布 SHA", mcpIdentity.sourceRevision), text("release", "MCP 发布", mcpIdentity.releaseId),
          text("instance", "配置实例", context.instanceId), time("started", "启动时间", startedAt),
          ...(lastToolSuccess ? [time("tool-success", "最近工具成功调用（来源未确认）", lastToolSuccess)] : []),
        ]), summary: "MCP 状态接口可读；云端端到端调用须单独核对" },
        ...(items.length ? items.map((entry) => now - entry.observedAt > 20_000 ? { ...entry, state: "unhealthy" as const, summary: "只读检查已过期，不能据历史成功判断当前正常", recovery: null } : entry) : [{ ...item("research-mcp.activity-read", "Activity 读取", null), state: "checking" as const, summary: "正在执行首次只读检查" }])] };
    },
    async stop() { stopped = true; clearInterval(timer); await inFlight; },
  };
}
