import type {
  AppServerCodexThreadDetail,
  AppServerThreadDetailStatus,
  AppServerThreadDetailTurn,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import {
  asRecord,
  isPresent,
  normalizeDate,
  normalizeDetailStatus,
  readNonNegativeNumber,
  readString,
} from "./codex-app-server-helpers.js";

const CODEX_THREAD_DETAIL_STATUS_TYPES = new Set<AppServerThreadDetailStatus>([
  "notLoaded",
  "idle",
  "systemError",
  "active",
]);

export function normalizeCodexThreadDetail(
  response: unknown,
  ref: AppServerThreadRef,
): AppServerCodexThreadDetail | null {
  const root = asRecord(response);
  const thread = asRecord(root?.thread);
  if (!thread) {
    return null;
  }
  const turns = Array.isArray(thread.turns)
    ? thread.turns.map(normalizeTurn).filter(isPresent)
    : [];
  const createdAt = normalizeDate(thread.createdAt) ?? ref.lastActivityAt;
  const updatedAt = normalizeDate(thread.updatedAt) ?? ref.updatedAt;
  const preview =
    readString(thread.preview) ??
    turns
      .flatMap((turn) => turn.messages)
      .find((message) => message.role === "user")?.text ??
    "";
  return {
    provider: "codex",
    threadId: readString(thread.id) ?? ref.threadId,
    preview,
    status:
      normalizeDetailStatusType(asRecord(thread.status)?.type ?? thread.status) ??
      normalizeDetailStatus(ref.status),
    createdAt,
    updatedAt,
    turns,
  };
}

function normalizeDetailStatusType(
  value: unknown,
): AppServerThreadDetailStatus | null {
  return typeof value === "string" &&
    CODEX_THREAD_DETAIL_STATUS_TYPES.has(value as AppServerThreadDetailStatus)
    ? (value as AppServerThreadDetailStatus)
    : null;
}

function normalizeTurn(
  value: unknown,
  index: number,
): AppServerThreadDetailTurn | null {
  const turn = asRecord(value);
  if (!turn) {
    return null;
  }
  const id = readString(turn.id) ?? `turn-${index + 1}`;
  const items = Array.isArray(turn.items) ? turn.items : [];
  const startedAt =
    normalizeDate(turn.startedAt) ?? normalizeDate(turn.createdAt) ?? undefined;
  const completedAt =
    normalizeDate(turn.completedAt) ?? normalizeDate(turn.updatedAt) ?? undefined;
  const durationMs =
    readNonNegativeNumber(turn.durationMs) ??
    (startedAt && completedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
      : undefined);
  return {
    id,
    status: normalizeTurnStatus(turn.status),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    itemsView: normalizeItemsView(turn.itemsView, items.length),
    itemCount: items.length,
    messages: items.flatMap((item, itemIndex) =>
      normalizeMessage(item, `${id}:${itemIndex + 1}`),
    ),
  };
}

function normalizeMessage(
  value: unknown,
  fallbackId: string,
): AppServerThreadDetailTurn["messages"] {
  const item = asRecord(value);
  if (!item) {
    return [];
  }
  const type = readString(item.type);
  const role = readString(item.role);
  const normalizedRole =
    type === "userMessage" || role === "user"
      ? "user"
      : type === "agentMessage" || role === "assistant"
        ? "assistant"
        : null;
  if (!normalizedRole) {
    return [];
  }
  const text = readMessageText(item);
  if (!text) {
    return [];
  }
  return [
    {
      id: readString(item.id) ?? fallbackId,
      role: normalizedRole,
      text,
    },
  ];
}

function readMessageText(item: Record<string, unknown>): string | null {
  const direct = readString(item.text);
  if (direct) {
    return direct;
  }
  const content = item.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((part) => {
    if (typeof part === "string") {
      return part.trim() ? [part] : [];
    }
    const record = asRecord(part);
    const text = record
      ? readString(record.text) ?? readString(record.inputText)
      : null;
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalizeTurnStatus(
  value: unknown,
): AppServerThreadDetailTurn["status"] {
  const raw = readString(asRecord(value)?.type ?? value)?.toLowerCase();
  if (raw === "completed") return "completed";
  if (raw === "interrupted" || raw === "cancelled" || raw === "canceled") {
    return "interrupted";
  }
  if (raw === "failed" || raw === "systemerror") return "failed";
  return "inProgress";
}

function normalizeItemsView(
  value: unknown,
  itemCount: number,
): AppServerThreadDetailTurn["itemsView"] {
  const raw = readString(value);
  return raw === "notLoaded" || raw === "summary" || raw === "full"
    ? raw
    : itemCount > 0
      ? "full"
      : "notLoaded";
}
