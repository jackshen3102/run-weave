import type { QualityBatch, QualityCapabilities, QualityReceipt } from "@runweave/shared/quality-workflow";
import { requestJson } from "./http";
export const qualityApi = (apiBase: string, token: string) => ({
  capabilities: () => requestJson<QualityCapabilities>(apiBase, "/api/quality-workflow/capabilities", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }),
  upload: (batch: QualityBatch) => requestJson<QualityReceipt>(apiBase, "/api/quality-workflow/batches", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(10_000) }),
});
