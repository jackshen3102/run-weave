import {
  normalizeRuntimeStatusId,
  type RuntimeStatusItem,
} from "@runweave/shared/runtime-status";
import { buildWorkspaceServiceUrl } from "./identity";
import type { WorkspaceServiceRecord } from "./manager-types";

export function buildWorkspaceServiceRuntimeStatusItems(
  records: Iterable<WorkspaceServiceRecord>,
  proxyPort: number | null,
  now: number,
): RuntimeStatusItem[] {
  return [...records].map((record) => {
    const status = record.status;
    const state =
      status === "ready"
        ? "healthy"
        : status === "starting" || status === "stopping"
          ? "recovering"
          : status === "failed"
            ? "unhealthy"
            : "disabled";
    const facts: RuntimeStatusItem["facts"] = [
      {
        id: "workspace-service.url",
        label: "地址",
        value: buildWorkspaceServiceUrl(
          record.identity.hostname,
          proxyPort ?? 0,
        ),
        kind: "address",
        copyable: true,
      },
    ];
    if (record.targetPort !== null) {
      facts.push({
        id: "workspace-service.target-port",
        label: "目标端口",
        value: String(record.targetPort),
        kind: "port",
        copyable: true,
      });
    }
    if (record.error) {
      facts.push({
        id: "workspace-service.error-code",
        label: "错误码",
        value: record.error.code,
        kind: "text",
        copyable: true,
      });
    }
    return {
      id: `backend.workspace-service:${normalizeRuntimeStatusId(record.projectId)}:${normalizeRuntimeStatusId(record.definition.name)}`,
      capabilityId: "workspace-services",
      label: record.definition.name,
      state,
      summary:
        record.error?.message ??
        (status === "ready"
          ? "Workspace Service 已就绪"
          : status === "starting"
            ? "Workspace Service 正在启动"
            : status === "stopping"
              ? "Workspace Service 正在停止"
              : "Workspace Service 已停用"),
      observedAt: now,
      dependsOn: ["backend.process"],
      recovery: null,
      facts,
      navigation: null,
    };
  });
}
