import {
  captureBrowserDownloads,
  listBrowserDownloads,
  readBrowserDownload,
} from "../../downloads.js";
import type { CdpProxyConnectionState } from "./types.js";
import { canUseTarget, sendJson } from "./utils.js";

export async function handleDownloadCommand(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<boolean> {
  if (
    ![
      "Runweave.captureDownloads",
      "Runweave.listDownloads",
      "Runweave.readDownload",
      "Browser.setDownloadBehavior",
    ].includes(method)
  )
    return false;
  const envelope = { id, ...(sessionId ? { sessionId } : {}) };
  try {
    if (sessionId && !conn.browserSessionIds.has(sessionId)) {
      const target = conn.sessionManager.getTargetIdForSession(sessionId);
      if (!target || !canUseTarget(conn, target))
        throw new Error("BROWSER_SCOPE_DENIED");
    }
    if (method === "Browser.setDownloadBehavior") {
      if (
        params.behavior !== "default" ||
        Object.keys(params).some((key) => key !== "behavior")
      )
        throw new Error(
          "DOWNLOAD_POLICY_UNSUPPORTED: use rw browser downloads capture for managed downloads",
        );
      sendJson(conn.ws, { ...envelope, result: {} });
      return true;
    }
    const group = conn.scopedGroupId;
    if (!group) throw new Error("DOWNLOAD_GROUP_REQUIRED");
    const keys =
      method === "Runweave.captureDownloads"
        ? ["enabled"]
        : method === "Runweave.readDownload"
          ? ["id", "offset"]
          : [];
    if (Object.keys(params).some((key) => !keys.includes(key)))
      throw new Error("INVALID_DOWNLOAD_ARGUMENTS");
    let result: unknown;
    if (method === "Runweave.captureDownloads") {
      if (typeof params.enabled !== "boolean")
        throw new Error("INVALID_DOWNLOAD_ARGUMENTS");
      result = captureBrowserDownloads(
        conn.scopedProfileId,
        group,
        params.enabled,
      );
    } else if (method === "Runweave.listDownloads") {
      result = { downloads: listBrowserDownloads(conn.scopedProfileId, group) };
    } else {
      if (
        typeof params.id !== "string" ||
        !Number.isSafeInteger(params.offset) ||
        (params.offset as number) < 0
      )
        throw new Error("INVALID_DOWNLOAD_ARGUMENTS");
      result = await readBrowserDownload(
        conn.scopedProfileId,
        group,
        params.id,
        params.offset as number,
      );
    }
    sendJson(conn.ws, { ...envelope, result });
  } catch (error) {
    sendJson(conn.ws, {
      ...envelope,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Download failed",
      },
    });
  }
  return true;
}
