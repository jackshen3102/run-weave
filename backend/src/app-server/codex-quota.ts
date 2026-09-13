import { discoverAppServer } from "@runweave/shared/app-server/discovery";
import { emptyCodexQuota, parseCodexQuotaSnapshot, type CodexQuotaSnapshot } from "@runweave/shared/app-server/codex-quota";

/** Forward only the normalized quota contract; never query this Backend's Codex process. */
export async function readCodexQuota(force: boolean, signal: AbortSignal): Promise<CodexQuotaSnapshot> {
  try {
    if (process.env.RUNWEAVE_APP_SERVER_DISCOVERY?.trim() === "disabled") return emptyCodexQuota("unavailable");
    const connection = await discoverAppServer({ env: process.env });
    if (!connection) return emptyCodexQuota("unavailable");
    const response = await fetch(`${connection.baseUrl}/codex/quota${force ? "?refresh=1" : ""}`, {
      signal, redirect: "error", headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (response.status === 404) return emptyCodexQuota("incompatible");
    if (!response.ok) return emptyCodexQuota("unavailable");
    return parseCodexQuotaSnapshot(await response.json()) ?? emptyCodexQuota("incompatible");
  } catch {
    return emptyCodexQuota("unavailable");
  }
}
