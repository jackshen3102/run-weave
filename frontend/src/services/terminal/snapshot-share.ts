import { parseTerminalSnapshotSharePath, type CreateTerminalSnapshotShareResponse } from "@runweave/shared/terminal/snapshot-share";
import { requestJson } from "../http";

function resolveShareApiBase(apiBase: string): string {
  const base = new URL(apiBase || window.location.origin, window.location.href);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Terminal sharing requires an HTTP(S) connection");
  }
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  return base.toString().replace(/\/+$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

async function resolveShareLinkBase(apiBase: string): Promise<string> {
  const base = new URL(apiBase);
  if (!isLoopbackHost(base.hostname)) return apiBase;

  const getReport = window.electronAPI?.getRuntimeStatusReport;
  if (!getReport) {
    throw new Error("请先使用局域网 IP 连接后再分享，本机地址无法供其他设备访问");
  }
  const report = await getReport();
  const backend = report.items.find((item) => item.id === "electron.packaged-backend");
  const network = report.items.find((item) => item.id === "electron.local-network");
  const backendAddress = backend?.facts.find((fact) => fact.id === "electron.packaged-backend.address")?.value;
  const lanAddress = network?.facts.find((fact) => fact.id === "electron.local-network.primary")?.value;
  if (!backendAddress || !lanAddress || network?.state !== "healthy") {
    throw new Error("未找到可用的局域网 IP，请连接网络后重试");
  }
  const local = new URL(backendAddress);
  const lan = new URL(lanAddress);
  const normalizeHost = (host: string) => host === "localhost" ? "127.0.0.1" : host;
  if (normalizeHost(local.hostname) !== normalizeHost(base.hostname) ||
      local.port !== base.port || local.protocol !== base.protocol ||
      lan.port !== local.port || lan.protocol !== local.protocol || isLoopbackHost(lan.hostname)) {
    throw new Error("当前连接不是内置本机 Backend，请使用该 Backend 的局域网 IP 连接后再分享");
  }
  // Change only the copied link's host. Keep the original connection for the
  // authenticated request, and retain its port, path prefix and signed query.
  base.hostname = lan.hostname;
  return base.toString().replace(/\/+$/, "");
}

export async function createTerminalSnapshotShare(
  apiBase: string,
  token: string,
  sessionId: string,
  panelId: string,
): Promise<CreateTerminalSnapshotShareResponse & { url: string }> {
  // Freeze and validate before creating: connection changes cannot redirect the
  // request or its resulting link, and renderer custom protocols are never used.
  const base = resolveShareApiBase(apiBase);
  const linkBase = await resolveShareLinkBase(base);
  const response = await requestJson<CreateTerminalSnapshotShareResponse>(
    base,
    `/api/terminal/session/${encodeURIComponent(sessionId)}/panels/${encodeURIComponent(panelId)}/shares`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  const access = parseTerminalSnapshotSharePath(response.sharePath);
  if (!access || access.expires !== Date.parse(response.expiresAt)) {
    throw new Error("Invalid terminal snapshot response");
  }
  return { ...response, url: `${linkBase}${response.sharePath}` };
}
