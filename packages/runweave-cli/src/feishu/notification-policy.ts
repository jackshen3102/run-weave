import { setTimeout as delay } from "node:timers/promises";
import type { TerminalFeishuDecision, TerminalFeishuNotificationRequest } from "@runweave/shared/terminal/completion";
import { resolveAuthContext, type AuthContext } from "../client/auth-context.js";
import { isHostedFeishuEndpoint } from "./node-notifier.js";

/** The detached notification process waits; the agent's Stop hook never does. */
export async function awaitFeishuNotification(
  payload: { terminalSessionId?: unknown; feishuNotificationId?: unknown },
  env: NodeJS.ProcessEnv,
  options: { profileName?: string; backendPort?: string; getAuthContext?: () => Promise<AuthContext> } = {},
): Promise<boolean> {
  const endpoint = env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT ?? env.RUNWEAVE_HOOK_ENDPOINT?.replace(/\/internal\/terminal\/agent-hook\/?$/, "/internal/terminal-completion");
  const token = env.RUNWEAVE_HOOK_TOKEN;
  // Direct, explicitly requested `rw feishu notify` remains a manual send.
  if (!env.RUNWEAVE_TERMINAL_SESSION_ID && payload.feishuNotificationId === undefined) return true;
  const notificationId = payload.feishuNotificationId;
  if (!endpoint || !token || typeof payload.terminalSessionId !== "string" || typeof notificationId !== "string" || !notificationId) return false;
  // The long-lived PTY Host does not proxy Feishu routes. Use this instance's
  // existing CLI login without changing or restarting the terminal owner.
  const auth = isHostedFeishuEndpoint(endpoint) ? await (options.getAuthContext?.() ?? resolveAuthContext({ ...options, env })) : null;
  const deadline = Date.now() + 35_000;
  while (Date.now() <= deadline) {
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalSessionId: payload.terminalSessionId, notificationId, claim: true } satisfies TerminalFeishuNotificationRequest),
      signal: AbortSignal.timeout(5_000),
      redirect: "error" as const,
    };
    let decision: TerminalFeishuDecision;
    if (auth) decision = await auth.requestJson<TerminalFeishuDecision>("/api/feishu/notification-policy", request);
    else {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/feishu`, {
        ...request, headers: { ...request.headers, "X-Runweave-Hook-Token": token },
      });
      if (!response.ok) return false;
      decision = await response.json() as TerminalFeishuDecision;
    }
    if (decision.action === "send") return true;
    if (decision.action !== "wait" || !Number.isFinite(decision.delayMs) || decision.delayMs <= 0 || decision.delayMs > 30_000) return false;
    await delay(decision.delayMs);
  }
  return false;
}
