import type {
  RemoteServiceRef,
  ResolvedServiceAccess,
} from "@runweave/shared/remote";
import type { WorkspaceServiceListResponse } from "@runweave/shared/terminal/workspace-service";
import type { TunnelSnapshot } from "@runweave/shared/tunnels";
export async function resolveTunnelService(
  read: () => TunnelSnapshot,
  raw: unknown,
  token: unknown,
): Promise<ResolvedServiceAccess> {
  const ref = raw as RemoteServiceRef;
  if (
    !ref ||
    !["endpointId", "parentProjectId", "projectId", "serviceId"].every(
      (key) =>
        typeof ref[key as keyof RemoteServiceRef] === "string" &&
        ref[key as keyof RemoteServiceRef].length > 0 &&
        ref[key as keyof RemoteServiceRef].length <= 512,
    ) ||
    typeof token !== "string" ||
    token.length > 8192
  )
    throw new Error("INVALID_SERVICE_REFERENCE");
  const snapshot = read();
  const endpoint = snapshot.config.backendEndpoints.find(
    (e) => e.id === ref.endpointId,
  );
  const host = snapshot.hosts.find((h) => h.hostId === endpoint?.hostId);
  const base = host?.endpoints[ref.endpointId];
  if (!endpoint || !host || host.state !== "ready" || !base)
    throw new Error("TUNNEL_UNAVAILABLE");
  const generation = host.generation;
  const response = await fetch(
    `${base}/api/terminal/project/${encodeURIComponent(ref.parentProjectId)}/contexts/${encodeURIComponent(ref.projectId)}/services`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(`Service lookup failed: HTTP ${response.status}`);
  const services = (await response.json()) as WorkspaceServiceListResponse;
  if (
    services.projectId !== ref.projectId ||
    services.parentProjectId !== ref.parentProjectId ||
    read().hosts.find((h) => h.hostId === host.hostId)?.generation !==
      generation
  )
    throw new Error("SERVICE_SNAPSHOT_CHANGED");
  const service = services.services.find((s) => s.name === ref.serviceId);
  if (!service || service.status !== "ready")
    throw new Error("SERVICE_NOT_READY");
  const url = new URL(service.url);
  if (
    url.protocol !== "http:" ||
    !/^[a-z0-9.-]+\.localhost$/.test(url.hostname) ||
    Number(url.port) !== endpoint.remotePort ||
    url.username ||
    url.password
  )
    throw new Error("UNSUPPORTED_SERVICE_ADDRESS");
  url.port = new URL(base).port;
  return { ref, generation, desktopUrl: url.toString() };
}
