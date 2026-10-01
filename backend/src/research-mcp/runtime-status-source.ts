import { readResearchMcpInstallation, resolveConfigurationContext } from "@runweave/config-node";
import { isRuntimeStatusState, type RuntimeStatusReport } from "@runweave/shared/runtime-status";
import type { RuntimeStatusRegistry } from "../runtime-status/registry";

/** Consume owner evidence; missing reports are a failure when the service is enabled. */
export function startResearchMcpRuntimeStatusSource(registry: RuntimeStatusRegistry): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let failedSince: number | null = null;
  let lastReport: RuntimeStatusReport | null = null;
  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= (async () => {
      const now = Date.now();
      const fallback = (state: "unconfigured" | "disabled" | "recovering" | "unhealthy", summary: string) => {
        if (stopped) return;
        registry.setExternalReport({ protocolVersion: 1, target: { kind: "local-host" },
          source: { id: "research-mcp", runtime: "research-mcp", instanceId: "research-mcp:unavailable", capabilityId: "research-mcp" },
          observedAt: now, validForMs: 20_000, items: [{ id: "research-mcp.source", capabilityId: "research-mcp", label: "调查 MCP 状态来源", state, summary, observedAt: now, dependsOn: [], facts: [], navigation: null,
            recovery: state === "recovering" ? { startedAt: failedSince!, attempt: null, maxAttempts: null, nextAttemptAt: now + 5000, deadlineAt: failedSince! + 30_000 } : null },
            ...(["recovering", "unhealthy"].includes(state) ? lastReport?.items.map((item) => ({ ...item, state: "blocked" as const, summary: "状态来源不可用，保留最后已知结果", dependsOn: ["research-mcp.source"], recovery: null })) ?? [] : [])] });
      };
      try {
        const installation = readResearchMcpInstallation();
        if (!installation) { failedSince = null; fallback("unconfigured", "尚未安装调查 MCP 常驻服务"); return; }
        if (!installation.enabled) { failedSince = null; fallback("disabled", "调查 MCP 已显式停用"); return; }
        const response = await fetch(`http://127.0.0.1:${installation.port}/runtime-status`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (!response.ok) throw new Error("owner_unavailable");
        const source = await response.text();
        if (source.length > 64 * 1024) throw new Error("report_too_large");
        const report = JSON.parse(source) as RuntimeStatusReport;
        if (report.protocolVersion !== 1 || report.source?.id !== "research-mcp" || report.source.runtime !== "research-mcp" || report.source.capabilityId !== "research-mcp" ||
          !Array.isArray(report.items) || report.items.length > 32 || report.validForMs !== 20_000 || !report.items.some((item) => item.id === "research-mcp.process" &&
            item.facts.some((fact) => fact.id === "instance" && fact.value === resolveConfigurationContext().instanceId) &&
            item.facts.some((fact) => fact.id === "release" && fact.value === installation.releaseId) &&
            item.facts.some((fact) => fact.id === "mcp-sha" && fact.value === installation.sourceRevision)) ||
          report.items.some((item) => item.capabilityId !== "research-mcp" || !item.id.startsWith("research-mcp.") || !isRuntimeStatusState(item.state))) throw new Error("invalid_owner_report");
        failedSince = null;
        const activity = report.items.find((item) => item.id === "research-mcp.activity-read");
        if (activity?.facts.some((fact) => fact.id === "backend-instance" && fact.value === registry.serviceInstanceId)) activity.dependsOn = ["backend.process", "backend.activity-store"];
        const tunnel = report.items.find((item) => item.id === "research-mcp.tunnel");
        if (tunnel) tunnel.dependsOn = ["research-mcp.process"];
        lastReport = report;
        if (!stopped) registry.setExternalReport(report);
      } catch {
        failedSince ??= now;
        fallback(now - failedSince < 30_000 ? "recovering" : "unhealthy", "已启用的调查 MCP 状态接口不可达或安装身份无效；请检查常驻服务日志");
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  void poll();
  const timer = setInterval(() => void poll(), 5000);
  timer.unref();
  return { async stop() { stopped = true; clearInterval(timer); await inFlight; } };
}
