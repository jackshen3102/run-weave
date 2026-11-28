import {
  HANDOFF_BUDGET_BYTES,
  type HandoffContextScope,
  type HandoffPlanFileCandidate,
} from "./context-handoff.js";
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

const MIDDLE_OMITTED =
  "\n\n[...middle omitted to stay within handoff budget...]\n\n";

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

function excerptHeadAndTail(text: string, bytes: number): string {
  if (size(text) <= bytes) return text;
  const markerBytes = size(MIDDLE_OMITTED);
  if (bytes < markerBytes + 16) return excerpt(text, bytes, true);
  const contentBudget = bytes - markerBytes;
  const headBytes = Math.floor(contentBudget / 2);
  const tailBytes = contentBudget - headBytes;
  return (
    excerpt(text, headBytes, false) +
    MIDDLE_OMITTED +
    excerpt(text, tailBytes, true)
  );
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
      // Even an oversized last answer (such as an unpersisted plan) should keep both its opening and conclusion.
      const last = messages.at(-1);
      if (i === visible.length - 1 && last) {
        const title = `\n\n### Turn #${i + 1} · ${last.role} (partial; head and tail preserved)\n`;
        const room = HANDOFF_BUDGET_BYTES - used - size(title + marker(i));
        if (room >= 4) {
          recent.push(title + excerptHeadAndTail(last.text, room));
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

export function applyPlanFilesToHandoffDocument(
  document: string,
  options: {
    contextScope: HandoffContextScope;
    planFiles: readonly Pick<
      HandoffPlanFileCandidate,
      "relativePath" | "absolutePath"
    >[];
  },
): string {
  if (!options.planFiles.length) return document;
  const lines = options.planFiles.map(
    (file) => `- \`${file.relativePath}\` (${file.absolutePath})`,
  );
  const planSection =
    options.contextScope === "plan_focused"
      ? `\n\n## Primary Plan Files (Read & Execute Directly)\nRead these plan files in full from the current working directory and treat them as the primary execution specification:\n${lines.join("\n")}`
      : `\n\n## Referenced Plan Files\nPlan files detected in the current working directory:\n${lines.join("\n")}`;

  const taskMarker = "\n\n## Original Task ";
  const taskIndex = document.indexOf(taskMarker);
  if (taskIndex < 0) {
    const combined = `${document}${planSection}`;
    return size(combined) <= HANDOFF_BUDGET_BYTES
      ? combined
      : excerpt(combined, HANDOFF_BUDGET_BYTES, false);
  }

  const header = document.slice(0, taskIndex);
  const body = document.slice(taskIndex);
  const turnPattern = /\n\n### Turn #\d+ · [^\n]+\n/g;
  const turnMatches = Array.from(body.matchAll(turnPattern));
  const omittedIndex = body.indexOf("\n\n## Omitted History Marker\n");
  const firstTailIndex = [
    omittedIndex >= 0 ? omittedIndex : Infinity,
    turnMatches[0]?.index ?? Infinity,
  ].reduce((min, value) => Math.min(min, value), Infinity);
  const originalTaskSection =
    firstTailIndex === Infinity ? body : body.slice(0, firstTailIndex);

  const turns = turnMatches.map((match, index) => {
    const start = match.index!;
    const end =
      index + 1 < turnMatches.length ? turnMatches[index + 1]!.index! : body.length;
    return body.slice(start, end);
  });

  if (options.contextScope === "plan_focused") {
    const prefix = header + planSection;
    const omittedNote =
      "\n\n## Omitted History Marker\nIntermediate discussion turns omitted in plan-focused mode. Read the primary plan files above; for additional discussion details use rw session-search search --query '<keyword>'.\n";
    const latestTurn = turns.at(-1) ?? "";
    const full = prefix + originalTaskSection + (latestTurn ? omittedNote + latestTurn : "");
    if (size(full) <= HANDOFF_BUDGET_BYTES) return full;

    const minReserve = size(prefix) + size(omittedNote);
    const taskRoom = Math.max(0, HANDOFF_BUDGET_BYTES - minReserve);
    if (size(originalTaskSection) >= taskRoom) {
      const suffix = "\n[Original task truncated at a UTF-8 boundary]";
      const room = Math.max(0, HANDOFF_BUDGET_BYTES - size(prefix) - size(suffix));
      return prefix + (room > 0 ? excerpt(originalTaskSection, room, false) + suffix : "");
    }

    const latestRoom =
      HANDOFF_BUDGET_BYTES - size(prefix + originalTaskSection + omittedNote);
    if (!latestTurn || latestRoom < 32) {
      return prefix + originalTaskSection;
    }
    const headingEnd = latestTurn.indexOf("\n", 2);
    if (headingEnd < 0) {
      return prefix + originalTaskSection + omittedNote + excerptHeadAndTail(latestTurn, latestRoom);
    }
    const turnHeading = latestTurn.slice(0, headingEnd + 1);
    const turnContent = latestTurn.slice(headingEnd + 1);
    const contentRoom = latestRoom - size(turnHeading);
    if (contentRoom < 8) return prefix + originalTaskSection;
    return (
      prefix +
      originalTaskSection +
      omittedNote +
      turnHeading +
      excerptHeadAndTail(turnContent, contentRoom)
    );
  }

  const combined = header + planSection + body;
  if (size(combined) <= HANDOFF_BUDGET_BYTES) return combined;

  const prefix = header + planSection + originalTaskSection;
  const omittedSection =
    omittedIndex >= 0
      ? body.slice(
          omittedIndex,
          turnMatches[0]?.index !== undefined && turnMatches[0].index > omittedIndex
            ? turnMatches[0].index
            : body.length,
        )
      : "\n\n## Omitted History Marker\nEarlier turns trimmed to fit referenced plan files within the 48 KiB handoff budget.\n";

  const kept: string[] = [];
  let used = size(prefix + omittedSection);
  for (let i = turns.length - 1; i >= 0; i--) {
    const block = turns[i]!;
    if (used + size(block) <= HANDOFF_BUDGET_BYTES) {
      kept.push(block);
      used += size(block);
    } else {
      if (i === turns.length - 1) {
        const room = HANDOFF_BUDGET_BYTES - used;
        const headingEnd = block.indexOf("\n", 2);
        if (headingEnd > 0) {
          const turnHeading = block.slice(0, headingEnd + 1);
          const contentRoom = room - size(turnHeading);
          if (contentRoom >= 8) {
            kept.push(
              turnHeading + excerptHeadAndTail(block.slice(headingEnd + 1), contentRoom),
            );
          }
        }
      }
      break;
    }
  }
  const trimmed = prefix + omittedSection + kept.reverse().join("");
  return size(trimmed) <= HANDOFF_BUDGET_BYTES
    ? trimmed
    : excerpt(trimmed, HANDOFF_BUDGET_BYTES, false);
}
