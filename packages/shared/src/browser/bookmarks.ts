/** Desktop-owned user content; independent of Profile, group and Backend. */
export type BookmarkEntry =
  | {
      id: string;
      kind: "link";
      title: string;
      url: string;
      faviconDataUrl: string | null;
    }
  | { id: string; kind: "folder"; title: string; children: string[] };
export type BookmarkLink = Extract<BookmarkEntry, { kind: "link" }>;
export interface BookmarkSnapshot {
  schemaVersion: 1;
  revision: number;
  barVisible: boolean;
  rootIds: string[];
  entries: BookmarkEntry[];
}
export type BookmarkOperation =
  | {
      kind: "add-link";
      title: string;
      url: string;
      parentId: string | null;
      faviconDataUrl: string | null;
    }
  | {
      kind: "edit-link";
      id: string;
      title: string;
      url: string;
      parentId: string | null;
    }
  | { kind: "add-folder"; title: string }
  | { kind: "rename-folder"; id: string; title: string }
  | {
      kind: "move";
      id: string;
      parentId: string | null;
      beforeId: string | null;
    }
  | { kind: "delete"; id: string; includeChildren: boolean }
  | { kind: "set-bar-visible"; visible: boolean };
export interface BookmarkMutation {
  expectedRevision: number;
  operation: BookmarkOperation;
}
export type BookmarkErrorCode =
  | "INVALID_INPUT"
  | "DUPLICATE_URL"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "STORE_UNAVAILABLE"
  | "UNSUPPORTED_SCHEMA"
  | "LIMIT_EXCEEDED"
  | "FORBIDDEN";
export interface BookmarkFailure {
  ok: false;
  error: { code: BookmarkErrorCode; message: string };
  snapshot?: BookmarkSnapshot;
}
export type BookmarkResult =
  | { ok: true; snapshot: BookmarkSnapshot; affectedId?: string }
  | BookmarkFailure;
export interface BookmarkTarget {
  tabId: string;
  url: string;
  title: string;
  faviconDataUrl: string | null;
}
export type BookmarkTargetResult =
  | { ok: true; target: BookmarkTarget }
  | BookmarkFailure;
export const BOOKMARK_MAX_ENTRIES = 5000;
export const BOOKMARK_MAX_BYTES = 16 * 1024 * 1024;
export function bookmarkUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 8192
  )
    throw new Error("请输入有效的 HTTP(S) 网址（最多 8192 字节）");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入有效的 HTTP(S) 网址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port === "0"
  )
    throw new Error("仅支持不含账号密码的 HTTP(S) 网址");
  return url.toString();
}
export function bookmarkTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value.trim()].length > 200
  )
    throw new Error("名称需要 1–200 个字符");
  return value.trim();
}
export function bookmarkParent(
  snapshot: BookmarkSnapshot,
  id: string,
): string | null {
  return (
    snapshot.entries.find((e) => e.kind === "folder" && e.children.includes(id))
      ?.id ?? null
  );
}
export function emptyBookmarks(): BookmarkSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    barVisible: true,
    rootIds: [],
    entries: [],
  };
}
export function bookmarkFailure(
  code: BookmarkErrorCode,
  message: string,
  snapshot?: BookmarkSnapshot,
): BookmarkFailure {
  return {
    ok: false,
    error: { code, message },
    ...(snapshot ? { snapshot } : {}),
  };
}
