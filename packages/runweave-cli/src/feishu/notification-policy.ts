import { setTimeout as delay } from "node:timers/promises";
import type { TerminalFeishuDecision, TerminalFeishuNotificationRequest } from "@runweave/shared/terminal/completion";

/** The detached notification process waits; the agent's Stop hook never does. */
export async function awaitFeishuNotification(
  payload: { terminalSessionId?: unknown; feishuNotificationId?: unknown },
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const endpoint = env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT ?? env.RUNWEAVE_HOOK_ENDPOINT?.replace(/\/internal\/terminal\/agent-hook\/?$/, "/internal/terminal-completion");
  const token = env.RUNWEAVE_HOOK_TOKEN;
  // Direct, explicitly requested `rw feishu notify` remains a manual send.
  if (!env.RUNWEAVE_TERMINAL_SESSION_ID && payload.feishuNotificationId === undefined) return true;
  const notificationId = payload.feishuNotificationId;
  if (!endpoint || !token || typeof payload.terminalSessionId !== "string" || typeof notificationId !== "string" || !notificationId) return false;
  const deadline = Date.now() + 35_000;
  while (Date.now() <= deadline) {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/feishu`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Runweave-Hook-Token": token },
      body: JSON.stringify({ terminalSessionId: payload.terminalSessionId, notificationId, claim: true } satisfies TerminalFeishuNotificationRequest),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const decision = await response.json() as TerminalFeishuDecision;
    if (decision.action === "send") return true;
    if (decision.action !== "wait" || !Number.isFinite(decision.delayMs) || decision.delayMs <= 0 || decision.delayMs > 30_000) return false;
    await delay(decision.delayMs);
  }
  return false;
}
