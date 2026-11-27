import { settingText } from "@runweave/config-node";
import { discoverAppServer } from "@runweave/config-node/app-server/discovery";
import { emptyAgyQuota, parseAgyQuotaSnapshot, type AgyQuotaSnapshot } from "@runweave/shared/app-server/agy-quota";

/** Forward only the normalized quota contract from App Server. */
export async function readAgyQuota(force: boolean, signal: AbortSignal): Promise<AgyQuotaSnapshot> {
  try {
    if (settingText("appServer.discovery")?.trim() === "disabled") return emptyAgyQuota("unavailable");
    const connection = await discoverAppServer({ env: process.env });
    if (!connection) return emptyAgyQuota("unavailable");
    const response = await fetch(`${connection.baseUrl}/agy/quota${force ? "?refresh=1" : ""}`, {
      signal, redirect: "error", headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (response.status === 404) return emptyAgyQuota("incompatible");
    if (!response.ok) return emptyAgyQuota("unavailable");
    return parseAgyQuotaSnapshot(await response.json()) ?? emptyAgyQuota("incompatible");
  } catch {
    return emptyAgyQuota("unavailable");
  }
}
