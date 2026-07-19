const STORAGE_KEY = "viewer.desktop-companion.failure-seen.v1";
const MAX_RECORDS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface SeenRecord {
  key: string;
  seenAt: number;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function load(): SeenRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as SeenRecord[];
    const cutoff = Date.now() - MAX_AGE_MS;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            typeof item?.key === "string" &&
            typeof item?.seenAt === "number" &&
            item.seenAt >= cutoff,
        ).slice(-MAX_RECORDS)
      : [];
  } catch {
    return [];
  }
}

function key(connectionId: string, attentionId: string): string {
  return `${connectionId}\n${attentionId}`;
}

export function hasSeenFailure(connectionId: string, attentionId: string): boolean {
  return load().some((item) => item.key === key(connectionId, attentionId));
}

export function markFailureSeen(connectionId: string, attentionId: string): void {
  if (!validId(connectionId) || !validId(attentionId)) return;
  const nextKey = key(connectionId, attentionId);
  const records = load().filter((item) => item.key !== nextKey);
  records.push({ key: nextKey, seenAt: Date.now() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
}
