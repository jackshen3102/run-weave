/** Identity and observation time of a main-process Claude hook, shared by both transports. */
export interface ClaudeAgentContext {
  version: 1;
  sessionId: string;
  instanceId: string;
  startedAt: number;
  observedAt: number;
  eventId: string;
  event: string;
  sessionSource?: string;
  notificationType?: string;
}

export function isClaudeAgentContext(value: unknown): value is ClaudeAgentContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 256;
  return v.version === 1 && text(v.sessionId) && text(v.instanceId) && text(v.eventId) &&
    text(v.event) && typeof v.startedAt === "number" && Number.isFinite(v.startedAt) && v.startedAt > 0 &&
    typeof v.observedAt === "number" && Number.isFinite(v.observedAt) && v.observedAt >= v.startedAt &&
    (v.sessionSource === undefined || text(v.sessionSource)) &&
    (v.notificationType === undefined || text(v.notificationType));
}

export function isNewerClaudeContext(next: ClaudeAgentContext, previous?: ClaudeAgentContext): boolean {
  if (!previous) return true;
  if (next.instanceId !== previous.instanceId) return next.startedAt > previous.startedAt;
  if (next.observedAt <= previous.observedAt) return false;
  // /clear and /resume must explicitly establish the new conversation.
  return next.sessionId === previous.sessionId || next.event === "sessionstart";
}

export function claudeHookStatus(context: ClaudeAgentContext): "running" | "idle" | null {
  if (context.event === "sessionstart") return context.sessionSource === "compact" ? null : "idle";
  if (["userpromptsubmit", "pretooluse", "posttooluse", "posttoolusefailure"].includes(context.event)) return "running";
  // Stop hooks can continue the turn. Native idle notification is settled evidence.
  if (context.event === "notification" && context.notificationType === "idle_prompt") return "idle";
  return null;
}
