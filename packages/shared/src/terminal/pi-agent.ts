/** Pi CLI identity is independent of its model provider (for example openai-codex). */
export interface PiAgentContext {
  version: 1;
  sessionId: string;
  sessionFile: string | null;
  instanceId: string;
  startedAt: string;
  sequence: number;
  runId: string | null;
  leafId: string | null;
  event: string;
  outcome: "completed" | "failed" | "interrupted" | null;
}

export function isPiAgentContext(value: unknown): value is PiAgentContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) =>
    typeof x === "string" && x.length > 0 && x.length <= 4096;
  const optionalText = (x: unknown) => x === null || text(x);
  return (
    v.version === 1 &&
    text(v.sessionId) &&
    optionalText(v.sessionFile) &&
    text(v.instanceId) &&
    text(v.startedAt) &&
    Number.isFinite(Date.parse(v.startedAt as string)) &&
    Number.isSafeInteger(v.sequence) &&
    (v.sequence as number) > 0 &&
    optionalText(v.runId) &&
    optionalText(v.leafId) &&
    text(v.event) &&
    (v.outcome === null ||
      v.outcome === "completed" ||
      v.outcome === "failed" ||
      v.outcome === "interrupted")
  );
}

export function isNewerPiContext(
  next: PiAgentContext,
  previous?: PiAgentContext,
): boolean {
  if (!previous) return true;
  return next.instanceId === previous.instanceId
    ? next.sequence > previous.sequence
    : Date.parse(next.startedAt) > Date.parse(previous.startedAt);
}

/** A private Unix socket operation; the Backend owns authentication and pane selection. */
export interface PiEditorRequest {
  version: 1;
  terminalSessionId: string;
  threadId: string;
  instanceId: string;
  requestId: string;
  text: string;
}

export interface PiEditorResponse {
  applied: boolean;
  error?: string;
}
