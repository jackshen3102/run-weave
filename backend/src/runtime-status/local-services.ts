import { configuration, LOCAL_RUNTIME_STATUS_SOURCES, readLocalRuntimeStatusReport, readNativeHostRuntimeStatusReport, readNativeHostSharingEnabled } from "@runweave/config-node";
import { expireRuntimeStatusReport, type RuntimeStatusReport, type RuntimeStatusState } from "@runweave/shared/runtime-status";

const sources = {
  electron: { runtime: "electron", label: "Desktop", capabilityId: "desktop", configured: () => process.env.ELECTRON_RUN_AS_NODE === "1" },
  "snapshot-host": { runtime: "snapshot-host", label: "快照分享 Host", capabilityId: "node", configured: () => configuredAny("services.snapshotHost", ["directory", "uploadToken"]) },
  "push-gateway": { runtime: "push-gateway", label: "推送网关", capabilityId: "node", configured: () => configuredAny("services.pushGateway", ["directory", "keyId", "teamId", "privateKeyFile", "adminToken"]) },
  "suiji-server": { runtime: "suiji-server", label: "随记服务", capabilityId: "node", configured: () => configuredAny("services.suiji", ["databaseURL", "storageDirectory"]) },
  "remote-desktop-host": { runtime: "remote-desktop-host", label: "RemoteDesk Host", capabilityId: "desktop", configured: readNativeHostSharingEnabled },
} as const;

function configuredAny(domain: string, fields: string[]): boolean {
  return fields.some(field => Boolean(configuration().get(`${domain}.${field}`)));
}

function unavailable(source: keyof typeof sources, state: RuntimeStatusState, summary: string, now: number): RuntimeStatusReport {
  const definition = sources[source];
  return { protocolVersion: 1, target: { kind: "local-host" }, source: { id: source, runtime: definition.runtime, instanceId: `${source}:unreported`, capabilityId: definition.capabilityId }, observedAt: now, validForMs: 20_000,
    items: [{ id: `${source}.source`, capabilityId: definition.capabilityId, label: definition.label, state, summary, observedAt: now, dependsOn: [], recovery: null, facts: [], navigation: null }] };
}

/** Same-instance owner files supplement HTTP reporters, including when the renderer is closed. */
export function readLocalServiceReports(now = Date.now()): RuntimeStatusReport[] {
  const reports: RuntimeStatusReport[] = LOCAL_RUNTIME_STATUS_SOURCES.map(source => {
    try {
      const expected = sources[source].configured();
      // Standalone services are enabled by deployment configuration. An old file
      // left after configuration removal cannot re-enable monitoring.
      if (source !== "electron" && !expected) return unavailable(source, "disabled", "此服务未启用，不检查健康状态", now);
      const stored = readLocalRuntimeStatusReport(source);
      if (stored) return stored.stopped ? stored.report : expireRuntimeStatusReport(stored.report, stored.receivedAt, now);
      return unavailable(source, expected ? "unsupported" : "disabled", expected
        ? "本机已配置此服务，但未收到状态；请检查是否已启动或更新到支持状态上报的版本"
        : "此节点未启用 Desktop，不检查健康状态", now);
    } catch { return unavailable(source, "unhealthy", "本机状态报告不可读或身份无效", now); }
  });
  // RemoteDesk is a same-user native service shared by local instances; no credentials are read.
  try {
    const stored = readNativeHostRuntimeStatusReport();
    if (stored) {
      reports.push(expireRuntimeStatusReport(stored.report, stored.receivedAt, now));
    } else {
      const expected = sources["remote-desktop-host"].configured();
      reports.push(unavailable("remote-desktop-host", expected ? "unsupported" : "disabled", expected
        ? "RemoteDesk 共享已启用，但尚无健康报告；请检查是否需要更新 Host"
        : "RemoteDesk 共享未启用，不检查健康状态", now));
    }
  } catch { reports.push(unavailable("remote-desktop-host", "unhealthy", "RemoteDesk Host 状态报告不可读或身份无效", now)); }
  return reports;
}
