/** Observation from the owning managed Codex TUI, never inferred from terminal text. */
export interface CodexConversationContext {
  protocolVersion: 1;
  generation: string;
  operationId: string;
  pid: number;
  revision: number;
  primaryThreadId: string | null;
  displayedThreadId: string | null;
  sides: Array<{ threadId: string; parentThreadId: string }>;
  displayedRunning: boolean;
  inputReady: boolean;
  closed: boolean;
}

export interface CodexInputContext {
  generation: string;
  revision: number;
  threadId: string;
}

export function isCodexConversationContext(value: unknown): value is CodexConversationContext {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<CodexConversationContext>;
  const id = (v: unknown) => v === null || (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v));
  return c.protocolVersion === 1 && typeof c.generation === "string" && c.generation.length > 0 &&
    typeof c.operationId === "string" && c.operationId.length > 0 &&
    Number.isSafeInteger(c.pid) && c.pid! > 0 && Number.isSafeInteger(c.revision) && c.revision! >= 0 &&
    id(c.primaryThreadId) && id(c.displayedThreadId) && typeof c.inputReady === "boolean" &&
    typeof c.displayedRunning === "boolean" && typeof c.closed === "boolean" && Array.isArray(c.sides) && c.sides.length <= 1 &&
    c.sides.every((side) => side && typeof side.threadId === "string" && id(side.threadId) &&
      typeof side.parentThreadId === "string" && id(side.parentThreadId));
}
