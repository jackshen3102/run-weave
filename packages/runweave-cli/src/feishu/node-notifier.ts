import type {
  FeishuNotifyPayload,
  FeishuTopicResult,
} from "@runweave/shared/feishu/bridge";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
export async function notifyFeishuNode(
  payload: FeishuNotifyPayload,
  env: NodeJS.ProcessEnv,
  profileName?: string,
  backendPort?: string,
): Promise<FeishuTopicResult> {
  const endpoint =
    env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT ??
    env.RUNWEAVE_HOOK_ENDPOINT?.replace(
      /\/internal\/terminal\/agent-hook\/?$/,
      "/internal/terminal-completion",
    );
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(40_000),
  };
  if (endpoint && env.RUNWEAVE_HOOK_TOKEN) {
    const response = await fetch(
      `${endpoint.replace(/\/$/, "")}/feishu/notify`,
      {
        ...init,
        headers: {
          ...init.headers,
          "X-Runweave-Hook-Token": env.RUNWEAVE_HOOK_TOKEN,
        },
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new CliError(
        "Feishu notification failed or result unknown; not retried",
        1,
      );
    return (await response.json()) as FeishuTopicResult;
  }
  const auth = await resolveAuthContext({ env, profileName, backendPort });
  return auth.requestJson<FeishuTopicResult>("/api/feishu/notify", init);
}
