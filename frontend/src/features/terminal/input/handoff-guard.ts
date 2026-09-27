/** Synchronous admission through the existing surface draft owner. */
export const HANDOFF_INPUT_EVENT = "runweave:handoff-input";
export interface HandoffInputGuard {
  apiBase: string;
  terminalSessionId: string;
  panelId: string | null;
  message?: string;
  release?: () => void;
}
export function claimHandoffInput(
  target: Pick<HandoffInputGuard, "apiBase" | "terminalSessionId" | "panelId">,
): () => void {
  const detail: HandoffInputGuard = { ...target };
  window.dispatchEvent(new CustomEvent(HANDOFF_INPUT_EVENT, { detail }));
  if (!detail.release)
    throw new Error(detail.message ?? "终端输入尚未就绪，请在终端中继续。");
  return detail.release;
}
