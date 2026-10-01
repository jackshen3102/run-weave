import type {
  ResourceMonitorResponse,
  ResourceMonitorSettings,
  ResourceRemoteControl,
  TerminateProcessResult,
} from "@runweave/shared/resource-monitor";
import { requestJson } from "./http";
export function resourceMonitorApi(apiBase: string, token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const root = "/api/device/resources";
  return {
    snapshot: (signal?: AbortSignal) =>
      requestJson<ResourceMonitorResponse>(apiBase, root, { headers, signal }),
    settings: (settings: ResourceMonitorSettings) =>
      requestJson<ResourceMonitorSettings>(apiBase, `${root}/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          expectedRevision: settings.revision,
          monitorEnabled: settings.monitorEnabled,
          alertsEnabled: settings.alertsEnabled,
        }),
      }),
    remoteControl: (permission: ResourceRemoteControl) =>
      requestJson<ResourceRemoteControl>(apiBase, `${root}/remote-control`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          expectedRevision: permission.revision,
          enabled: permission.enabled,
        }),
      }),
    snooze: (alertId: string) =>
      requestJson<{ ok: boolean }>(
        apiBase,
        `${root}/alerts/${encodeURIComponent(alertId)}/snooze`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ durationMinutes: 60 }),
        },
      ),
    terminate: (id: string, force: boolean, requestId: string) =>
      requestJson<TerminateProcessResult>(
        apiBase,
        `${root}/processes/${encodeURIComponent(id)}/terminate`,
        { method: "POST", headers, body: JSON.stringify({ force, requestId }) },
      ),
  };
}
