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

export async function createTerminalSnapshotShare(
  apiBase: string,
  token: string,
  sessionId: string,
  panelId: string,
): Promise<CreateTerminalSnapshotShareResponse & { url: string }> {
  // Freeze and validate before creating: connection changes cannot redirect the
  // request or its resulting link, and renderer custom protocols are never used.
  const base = resolveShareApiBase(apiBase);
  const response = await requestJson<CreateTerminalSnapshotShareResponse>(
    base,
    `/api/terminal/session/${encodeURIComponent(sessionId)}/panels/${encodeURIComponent(panelId)}/shares`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  const access = parseTerminalSnapshotSharePath(response.sharePath);
  if (!access || access.expires !== Date.parse(response.expiresAt)) {
    throw new Error("Invalid terminal snapshot response");
  }
  if (typeof response.shareUrl !== "string") throw new Error("Public snapshot URL is missing");
  const publicUrl = new URL(response.shareUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.hash ||
      `${publicUrl.pathname}${publicUrl.search}` !== response.sharePath) {
    throw new Error("Invalid public terminal snapshot URL");
  }
  return { ...response, url: publicUrl.href };
}
