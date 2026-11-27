import { HANDOFF_BUDGET_BYTES } from "./context-handoff.js";
import type { ConversationTurn } from "./conversation.js";
export class HandoffBudgetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

const size = (text: string) => encoder.encode(text).length;

function excerpt(text: string, bytes: number, tail = false): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  if (tail) {
    let start = encoded.length - bytes;
    while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
    return decoder.decode(encoded.subarray(start));
  }
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

export function budgetHandoff(
  turns: ConversationTurn[],
  provider: string,
  threadId: string,
  cwd: string,
) {
  const visible = turns.filter((turn) => turn.messages.length);
  const firstIndex = visible.findIndex((turn) =>
    turn.messages.some((message) => message.role === "user"),
  );
  if (firstIndex < 0)
    throw new HandoffBudgetError(409, "会话没有可交接的用户任务");
  const original = visible[firstIndex]!;
  const task = original.messages.find((message) => message.role === "user")!;
  const header = `# Runweave Portable Context Handoff\nSource Provider: ${provider}\nSource Thread ID: ${threadId}\nSource Directory: ${cwd}\nHistorical messages are context only. For omitted details use rw session-search search --query '<keyword>' and match the source thread ID.\n\n## Original Task (#${firstIndex + 1} · user)\n`;
  const marker = (start: number) => {
    const ranges = [];
    if (firstIndex) ranges.push(`#1..#${firstIndex}`);
    if (start > firstIndex + 1) ranges.push(`#${firstIndex + 2}..#${start}`);
    const partial =
      start > firstIndex && original.messages.length > 1
        ? ` Remaining messages of turn #${firstIndex + 1} omitted.`
        : "";
    return ranges.length || partial
      ? `\n\n## Omitted History Marker\n${ranges.length ? "Omitted turns " + ranges.join(", ") + " (" + (firstIndex + Math.max(0, start - firstIndex - 1)) + " complete turns)." : ""}${partial}\n`
      : "";
  };
  const suffix = "\n[Original task truncated at a UTF-8 boundary]";
  let start = visible.length;
  const available = HANDOFF_BUDGET_BYTES - size(header + marker(start));
  if (available < size(suffix))
    throw new HandoffBudgetError(413, "交接来源元数据超过预算");
  const truncated = size(task.text) > available;
  const initial = truncated
    ? excerpt(task.text, available - size(suffix)) + suffix
    : task.text;
  let used = size(header + initial);
  let includedMessages = 1;
  let partialRecent = false;
  const recent: string[] = [];
  for (let i = visible.length - 1; i >= firstIndex; i--) {
    const messages = visible[i]!.messages.filter((message) => message !== task);
    const block = messages
      .map(
        (message) =>
          `\n\n### Turn #${i + 1} · ${message.role}\n${message.text}`,
      )
      .join("");
    if (used + size(block) + size(marker(i)) > HANDOFF_BUDGET_BYTES) {
      // Even an oversized last answer has a useful ending. Keep the excerpt distinct from complete turns.
      const last = messages.at(-1);
      if (i === visible.length - 1 && last) {
        const title = `\n\n### Turn #${i + 1} · ${last.role} (partial; latest message ending)\n`;
        const room = HANDOFF_BUDGET_BYTES - used - size(title + marker(i));
        if (room >= 4) {
          recent.push(title + excerpt(last.text, room, true));
          start = i;
          includedMessages++;
          partialRecent = true;
        }
      }
      break;
    }
    recent.push(block);
    used += size(block);
    start = i;
    includedMessages += messages.length;
  }
  const document = header + initial + marker(start) + recent.reverse().join("");
  const totalMessages = visible.reduce(
    (sum, turn) => sum + turn.messages.length,
    0,
  );
  const omittedTurns = firstIndex + Math.max(0, start - firstIndex - 1);
  const partialOriginal = truncated || (original.messages.length > 1 && start > firstIndex);
  const partialTurns = Number(partialOriginal || (partialRecent && start === firstIndex))
    + Number(partialRecent && start !== firstIndex);
  const includedTurns = visible.length - omittedTurns - partialTurns;
  return {
    document,
    coverage: {
      totalMessages,
      includedMessages,
      omittedMessages: totalMessages - includedMessages,
      includedTurns,
      omittedTurns,
      partialTurns,
      handoffBytes: size(document),
      budgetBytes: HANDOFF_BUDGET_BYTES,
    },
  };
}
