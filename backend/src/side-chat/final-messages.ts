/** Raw process events stay in memory; only successful final text crosses the domain boundary. */
export interface ProviderItem { id: string; type: string; text?: string; phase?: string | null }
export interface ProviderTurn { id: string; status: string; items?: ProviderItem[] }
export function finalMessages(turn: ProviderTurn): Array<{ id: string; text: string }> {
  if (turn.status !== "completed") return [];
  const candidates = [...new Map((turn.items ?? [])
    .filter(item => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
    .map(item => [item.id, item])).values()];
  const finals = candidates.filter(item => item.phase === "final_answer");
  const selected = finals.length ? finals : candidates.at(-1)?.phase == null ? candidates.slice(-1) : [];
  return selected.map(item => ({ id: item.id, text: item.text! }));
}
