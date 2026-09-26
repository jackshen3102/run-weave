import { createHmac } from "node:crypto";
import { settingText } from "@runweave/config-node";
import { CliError } from "../errors.js";

/** Compatibility transport; credentials are read only by the owning CLI. */
export async function notifyFeishuWebhook(text: string): Promise<void> {
  const url = settingText("services.feishu.legacyWebhook.url");
  if (!url) throw new CliError("CONFIG_FEISHU_WEBHOOK_REQUIRED", 2);
  const secret = settingText("services.feishu.legacyWebhook.secret");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = {
    msg_type: "text", content: { text },
    ...(secret ? { timestamp, sign: createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64") } : {}),
  };
  try {
    const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as { code?: number; StatusCode?: number };
    if (!response.ok || (result.code ?? result.StatusCode ?? -1) !== 0) throw new Error();
  } catch { throw new CliError("CONFIG_FEISHU_WEBHOOK_DELIVERY_FAILED", 1); }
}
