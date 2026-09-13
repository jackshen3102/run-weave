import { emptyCodexQuota, parseCodexQuotaSnapshot, type CodexQuotaSnapshot } from "@runweave/shared/app-server/codex-quota";
import { HttpError } from "./http";

export async function fetchCodexQuota(apiBase: string, token: string, force: boolean, signal: AbortSignal): Promise<CodexQuotaSnapshot> {
  const response = await fetch(`${apiBase.replace(/\/+$/u, "")}/api/codex/quota${force ? "?refresh=1" : ""}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
  });
  if (response.status === 404) throw new Error("当前 Backend 版本不支持 Codex 额度");
  if (response.status === 401) {
    // Only the Backend's auth rejection invalidates its session, not a proxy login page.
    const body: unknown = response.headers.get("content-type")?.includes("application/json")
      ? await response.json().catch(() => null) : null;
    if (body && typeof body === "object" && "message" in body && body.message === "Unauthorized") {
      throw new HttpError(401, "登录已失效，请重新登录当前连接");
    }
    throw new Error("连接访问被拒绝，请检查代理或网络认证");
  }
  if (!response.ok) throw new Error("额度更新失败，请稍后重试");
  return parseCodexQuotaSnapshot(await response.json()) ?? emptyCodexQuota("incompatible");
}
