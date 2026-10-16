import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { configuration } from "@runweave/config-node";
import { isCodexConversationContext, type CodexConversationContext } from "@runweave/shared/terminal/codex-context";
import type { TerminalPanelRecord } from "../manager/records";

export function codexContextPath(terminalSessionId: string, panelId: string): string {
  const key = createHash("sha256").update(`${terminalSessionId}\0${panelId}`).digest("hex");
  return path.join(configuration().context.configRoot, "codex-context", `${key}.json`);
}

export function clearCodexContext(terminalSessionId: string, panelId: string): void {
  const observed = readCodexContext({ terminalSessionId, id: panelId });
  // A failed preparation must not erase the observation of a still-running TUI.
  if (!observed.context || observed.context.closed)
    rmSync(codexContextPath(terminalSessionId, panelId), { force: true });
}

/** null = unmanaged; managed without a valid live snapshot must fail closed. */
export function readCodexContext(panel: Pick<TerminalPanelRecord, "id" | "terminalSessionId">): {
  managed: boolean;
  context: CodexConversationContext | null;
} {
  const file = codexContextPath(panel.terminalSessionId, panel.id);
  if (!existsSync(file)) return { managed: false, context: null };
  try {
    const bytes = readFileSync(file);
    if (bytes.length > 16_384) return { managed: true, context: null };
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isCodexConversationContext(value)) return { managed: true, context: null };
    try { process.kill(value.pid, 0); }
    catch { return { managed: true, context: { ...value, closed: true, inputReady: false, displayedThreadId: null } }; }
    return { managed: true, context: value };
  } catch { return { managed: true, context: null }; }
}

export function codexHookBelongsToPrimary(panel: TerminalPanelRecord, threadId: string | null | undefined, initialSessionStart = false): boolean {
  const { managed, context } = readCodexContext(panel);
  return !managed || Boolean(threadId && context && !context.closed &&
    (context.primaryThreadId === threadId || (initialSessionStart && context.revision === 0)));
}
