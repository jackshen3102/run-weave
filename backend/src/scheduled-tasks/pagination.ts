import type { ScheduledTaskPage } from "@runweave/shared/scheduled-tasks";
import { ScheduledTaskError } from "./errors";

export function paginate<T>(
  items: T[],
  cursor?: string,
  requestedLimit?: number,
): ScheduledTaskPage<T> {
  const offset = decodeOffset(cursor);
  const limit = Math.min(100, Math.max(1, requestedLimit ?? 50));
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    nextCursor:
      offset + page.length < items.length ? String(offset + page.length) : null,
  };
}
export function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ScheduledTaskError("invalid_input", 400, "Invalid cursor");
  return value;
}
