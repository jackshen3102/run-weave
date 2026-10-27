export const HISTORY_BATCH_BYTES = 256 * 1024;
export const HISTORY_ROW_BYTES = 8 * 1024;
export const HISTORY_QUEUE_BYTES = 4 * 1024 * 1024;
export const HISTORY_HOST = "cn.runweave.browser_history";
export type HistoryBrowser = "chrome" | "edge" | "runweave";
export interface BrowserVisitObservation {
  schemaVersion: 1;
  sourceId: string;
  browser: HistoryBrowser;
  visitId: string;
  revision: number;
  visitedAt: string;
  observedAt: string;
  url: string;
  title: string | null;
  navigation: "document" | "same-document";
  profileLabel: string;
  scope?: { profileId?: string; groupId?: string; tabId?: string };
  actor: "unknown";
}
export interface BrowserHistoryStatus {
  enabled: boolean;
  sourceId: string;
  root: string;
  pending: number;
  lastStoredAt: string | null;
  error: string | null;
}
export function historyUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
export function historyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = url.password = url.search = url.hash = "";
    const result = url.toString();
    return result.length <= 4096 ? result : null;
  } catch {
    return null;
  }
}
export function historyTitle(value: string, url?: string): string | null {
  const title =
    Array.from(value.replace(/[\r\n\t]/g, " ").trim())
      .slice(0, 512)
      .join("") || null;
  // Chromium displays the address when a document has no title.
  if (
    title &&
    url &&
    [url, historyUrl(url)].some(
      (u) => u && (title === u || title === u.replace(/^https?:\/\//, "")),
    )
  )
    return null;
  return title;
}
function iso(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function validateHistoryObservation(
  value: unknown,
): asserts value is BrowserVisitObservation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INVALID_OBSERVATION");
  const v = value as BrowserVisitObservation;
  if (typeof v.schemaVersion === "number" && v.schemaVersion > 1)
    throw Error("UNSUPPORTED_HISTORY_SCHEMA");
  const keys = [
    "schemaVersion",
    "sourceId",
    "browser",
    "visitId",
    "revision",
    "visitedAt",
    "observedAt",
    "url",
    "title",
    "navigation",
    "profileLabel",
    "scope",
    "actor",
  ];
  if (
    Object.keys(v).some((k) => !keys.includes(k)) ||
    v.schemaVersion !== 1 ||
    !historyUuid(v.sourceId) ||
    !historyUuid(v.visitId) ||
    !["chrome", "edge", "runweave"].includes(v.browser) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    !iso(v.visitedAt) ||
    !iso(v.observedAt) ||
    typeof v.url !== "string" ||
    historyUrl(v.url) !== v.url ||
    (v.title !== null &&
      (typeof v.title !== "string" || historyTitle(v.title) !== v.title)) ||
    !["document", "same-document"].includes(v.navigation) ||
    v.actor !== "unknown" ||
    typeof v.profileLabel !== "string" ||
    !v.profileLabel.trim() ||
    v.profileLabel.length > 128 ||
    new TextEncoder().encode(JSON.stringify(v)).length + 1 > HISTORY_ROW_BYTES
  )
    throw Error("INVALID_OBSERVATION");
  if (
    v.scope !== undefined &&
    (!v.scope ||
      typeof v.scope !== "object" ||
      Array.isArray(v.scope) ||
      Object.entries(v.scope).some(
        ([k, x]) =>
          !["profileId", "groupId", "tabId"].includes(k) ||
          typeof x !== "string" ||
          !x ||
          x.length > 512,
      ))
  )
    throw Error("INVALID_SCOPE");
}
export function historyObservationKey(v: BrowserVisitObservation): string {
  return `${v.sourceId}:${v.visitId}:${v.revision}`;
}
