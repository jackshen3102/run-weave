/** Identity and observation time of a main-process Antigravity CLI (agy) hook. */
export interface AgyAgentContext {
  version: 1;
  conversationId: string;
  instanceId: string;
  startedAt: number;
  observedAt: number;
  eventId: string;
  event: string;
  terminationReason?: string;
  fullyIdle?: boolean;
  modelName?: string;
  transcriptPath?: string;
}

export function isAgyAgentContext(value: unknown): value is AgyAgentContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max = 256) => typeof x === "string" && x.length > 0 && x.length <= max;
  return (
    v.version === 1 &&
    text(v.conversationId) &&
    text(v.instanceId) &&
    text(v.eventId) &&
    text(v.event) &&
    typeof v.startedAt === "number" &&
    Number.isFinite(v.startedAt) &&
    v.startedAt > 0 &&
    typeof v.observedAt === "number" &&
    Number.isFinite(v.observedAt) &&
    v.observedAt >= v.startedAt &&
    (v.terminationReason === undefined || text(v.terminationReason)) &&
    (v.fullyIdle === undefined || typeof v.fullyIdle === "boolean") &&
    (v.modelName === undefined || text(v.modelName)) &&
    (v.transcriptPath === undefined || text(v.transcriptPath, 4096))
  );
}

export function isNewerAgyContext(next: AgyAgentContext, previous?: AgyAgentContext): boolean {
  if (!previous) return true;
  if (next.instanceId !== previous.instanceId) return next.startedAt > previous.startedAt;
  if (next.observedAt <= previous.observedAt) return false;
  // Explicit SessionStart may establish a new conversation on the same pane instance.
  return next.conversationId === previous.conversationId || next.event === "sessionstart";
}

export function agyHookStatus(context: AgyAgentContext): "running" | "idle" | null {
  if (context.event === "sessionstart") return "idle";
  if (["preinvocation", "pre_invocation", "postinvocation", "post_invocation", "pretooluse", "pre_tool_use", "posttooluse", "post_tool_use"].includes(context.event)) {
    return "running";
  }
  if (context.event === "stop") {
    if (context.terminationReason === "ERROR" || context.terminationReason === "USER_CANCELED") {
      return "idle";
    }
    if ((context.terminationReason === undefined || context.terminationReason === "NO_TOOL_CALL") && context.fullyIdle !== false) {
      return "idle";
    }
    return null;
  }
  return null;
}
