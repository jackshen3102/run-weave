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
        if (!installation) { failedSince = null; fallback("disabled", "调查 MCP 未安装启用，不检查健康状态"); return; }
        if (!installation.enabled) { failedSince = null; fallback("disabled", "调查 MCP 已显式停用"); return; }
        const response = await fetch(`http://127.0.0.1:${installation.port}/runtime-status`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (!response.ok) throw new Error("owner_unavailable");
        const source = await response.text();
        if (source.length > 64 * 1024) throw new Error("report_too_large");
        const report = JSON.parse(source) as RuntimeStatusReport;
        if (report.protocolVersion !== 1 || report.source?.id !== "research-mcp" || report.source.runtime !== "research-mcp" || report.source.capabilityId !== "research-mcp" ||
          !Array.isArray(report.items) || report.items.length > 32 || report.validForMs !== 20_000 || !report.items.some((item) => item.id === "research-mcp.process" &&
            item.facts.some((fact) => fact.id === "instance" && fact.value === resolveConfigurationContext().instanceId)) ||
          report.items.some((item) => item.capabilityId !== "research-mcp" || !item.id.startsWith("research-mcp.") || !isRuntimeStatusState(item.state))) throw new Error("invalid_owner_report");
        const processItem = report.items.find(item => item.id === "research-mcp.process")!;
        const installedMatches = processItem.facts.some(fact => fact.id === "release" && fact.value === installation.releaseId) && processItem.facts.some(fact => fact.id === "mcp-sha" && fact.value === installation.sourceRevision);
        // An already-verified owner may still run the previous artifact after installation.
        // A newly discovered mismatched generation remains untrusted.
        const knownProcess = lastReport?.source.instanceId === report.source.instanceId &&
          ["release", "mcp-sha"].every(id => processItem.facts.find(fact => fact.id === id)?.value === lastReport?.items.find(item => item.id === "research-mcp.process")?.facts.find(fact => fact.id === id)?.value);
        if (!installedMatches && !knownProcess) throw new Error("installation_generation_mismatch");
        failedSince = null;
        const activity = report.items.find((item) => item.id === "research-mcp.activity-read");
        if (activity?.facts.some((fact) => fact.id === "backend-instance" && fact.value === registry.serviceInstanceId)) activity.dependsOn = ["backend.process", "backend.activity-store"];
        const tunnel = report.items.find((item) => item.id === "research-mcp.tunnel");
        if (tunnel) tunnel.dependsOn = ["research-mcp.process"];
        lastReport = report;
        if (!stopped) registry.setExternalReport(report);
      } catch {
        failedSince ??= now;
        fallback(now - failedSince < 30_000 ? "recovering" : "unhealthy", "已启用的调查 MCP 不可达或运行身份与安装身份不一致；请检查是否需要更新或重启常驻服务");
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  void poll();
  const timer = setInterval(() => void poll(), 5000);
  timer.unref();
  return { async stop() { stopped = true; clearInterval(timer); await inFlight; } };
}
