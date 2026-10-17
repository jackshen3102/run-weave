import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  BOOKMARK_MAX_BYTES,
  BOOKMARK_MAX_ENTRIES,
  bookmarkFailure,
  bookmarkTitle,
  bookmarkUrl,
  emptyBookmarks,
  type BookmarkEntry,
  type BookmarkMutation,
  type BookmarkResult,
  type BookmarkSnapshot,
} from "@runweave/shared/terminal-browser-bookmarks";

function validateSnapshot(value: unknown): BookmarkSnapshot {
  const s = value as BookmarkSnapshot;
  if (
    !s ||
    s.schemaVersion !== 1 ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 0 ||
    typeof s.barVisible !== "boolean" ||
    !Array.isArray(s.entries) ||
    !Array.isArray(s.rootIds) ||
    s.entries.length > BOOKMARK_MAX_ENTRIES
  )
    throw Error("Invalid snapshot");
  const ids = new Set<string>();
  const urls = new Set<string>();
  const references: string[] = [...s.rootIds];
  for (const e of s.entries) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !e.id ||
      ids.has(e.id) ||
      bookmarkTitle(e.title) !== e.title
    )
      throw Error("Invalid entry");
    ids.add(e.id);
    if (e.kind === "link") {
      if (
        bookmarkUrl(e.url) !== e.url ||
        urls.has(e.url) ||
        (e.faviconDataUrl !== null &&
          (typeof e.faviconDataUrl !== "string" ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(
              e.faviconDataUrl,
            ) ||
            e.faviconDataUrl.length > 8192))
      )
        throw Error("Invalid link");
      urls.add(e.url);
    } else if (
      e.kind === "folder" &&
      Array.isArray(e.children) &&
      s.rootIds.includes(e.id)
    ) {
      for (const id of e.children)
        if (!s.entries.some((x) => x.id === id && x.kind === "link"))
          throw Error("Invalid child");
      references.push(...e.children);
    } else throw Error("Invalid folder");
  }
  if (
    references.length !== ids.size ||
    new Set(references).size !== ids.size ||
    references.some((id) => !ids.has(id))
  )
    throw Error("Invalid order");
  return s;
}

/** The caller supplies the existing desktop atomic writer, or a real filesystem fixture writer. */
export class BookmarkStore {
  private state: BookmarkSnapshot | null = null;
  constructor(
    private readonly file: string,
    private readonly write: (file: string, value: BookmarkSnapshot) => void,
  ) {}
  read(): BookmarkResult {
    if (this.state) return { ok: true, snapshot: structuredClone(this.state) };
    try {
      if (statSync(this.file).size > BOOKMARK_MAX_BYTES)
        return bookmarkFailure(
          "STORE_UNAVAILABLE",
          "收藏文件超过容量限制，原数据已保留",
        );
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof raw?.schemaVersion === "number" && raw.schemaVersion > 1)
        return bookmarkFailure(
          "UNSUPPORTED_SCHEMA",
          "不支持的收藏格式，请更新客户端",
        );
      this.state = validateSnapshot(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.state = emptyBookmarks();
      else
        return bookmarkFailure(
          "STORE_UNAVAILABLE",
          "无法读取收藏夹，原数据已保留；请修复文件后重试",
        );
    }
    return { ok: true, snapshot: structuredClone(this.state) };
  }
  mutate(request: BookmarkMutation): BookmarkResult {
    const loaded = this.read();
    if (!loaded.ok) return loaded;
    const current = loaded.snapshot;
    if (
      !request ||
      !Number.isSafeInteger(request.expectedRevision) ||
      !request.operation
    )
      return bookmarkFailure("INVALID_INPUT", "无效的收藏操作");
    if (request.expectedRevision !== current.revision)
      return bookmarkFailure(
        "REVISION_CONFLICT",
        "收藏已在其他窗口更新，请核对后重试",
        current,
      );
    const next = structuredClone(current);
    const op = request.operation;
    let affectedId: string | undefined;
    const find = (id: string): BookmarkEntry => {
      const e = next.entries.find((x) => x.id === id);
      if (!e) throw Error("找不到收藏项目");
      return e;
    };
    const container = (parent: string | null): string[] => {
      if (parent === null) return next.rootIds;
      const e = next.entries.find((entry) => entry.id === parent);
      if (!e || e.kind !== "folder") throw Error("无效的文件夹");
      return e.children;
    };
    const detach = (id: string) => {
      next.rootIds = next.rootIds.filter((x) => x !== id);
      for (const e of next.entries)
        if (e.kind === "folder")
          e.children = e.children.filter((x) => x !== id);
    };
    try {
      switch (op.kind) {
        case "add-link": {
          const title = bookmarkTitle(op.title);
          const url = bookmarkUrl(op.url);
          const dest = container(op.parentId);
          const existing = next.entries.find(
            (e) => e.kind === "link" && e.url === url,
          );
          if (existing)
            return { ok: true, snapshot: current, affectedId: existing.id };
          affectedId = randomUUID();
          next.entries.push({
            id: affectedId,
            kind: "link",
            title,
            url,
            faviconDataUrl: op.faviconDataUrl,
          });
          dest.push(affectedId);
          break;
        }
        case "add-folder":
          affectedId = randomUUID();
          next.entries.push({
            id: affectedId,
            kind: "folder",
            title: bookmarkTitle(op.title),
            children: [],
          });
          next.rootIds.push(affectedId);
          break;
        case "edit-link": {
          const e = find(op.id);
          if (e.kind !== "link") throw Error("无效的收藏");
          const title = bookmarkTitle(op.title);
          const url = bookmarkUrl(op.url);
          container(op.parentId);
          if (
            next.entries.some(
              (x) => x.kind === "link" && x.id !== e.id && x.url === url,
            )
          )
            return bookmarkFailure("DUPLICATE_URL", "这个网址已经在收藏夹中");
          const currentParent =
            next.entries.find(
              (x) => x.kind === "folder" && x.children.includes(e.id),
            )?.id ?? null;
          if (currentParent !== op.parentId) {
            detach(e.id);
            container(op.parentId).push(e.id);
          }
          if (e.url !== url) e.faviconDataUrl = null;
          Object.assign(e, { title, url });
          affectedId = e.id;
          break;
        }
        case "rename-folder": {
          const e = find(op.id);
          if (e.kind !== "folder") throw Error("无效的文件夹");
          e.title = bookmarkTitle(op.title);
          affectedId = e.id;
          break;
        }
        case "move": {
          const e = find(op.id);
          if (e.kind === "folder" && op.parentId !== null)
            throw Error("文件夹只支持一层");
          const target = container(op.parentId);
          if (op.beforeId !== null && !target.includes(op.beforeId))
            throw Error("无效的排序位置");
          if (op.beforeId === e.id) break;
          detach(e.id);
          const dest = container(op.parentId);
          dest.splice(
            op.beforeId === null ? dest.length : dest.indexOf(op.beforeId),
            0,
            e.id,
          );
          affectedId = e.id;
          break;
        }
        case "delete": {
          const e = find(op.id);
          if (typeof op.includeChildren !== "boolean")
            throw Error("无效的删除操作");
          if (e.kind === "folder" && e.children.length && !op.includeChildren)
            throw Error("请确认删除文件夹及其中的收藏");
          const ids = new Set([
            e.id,
            ...(e.kind === "folder" ? e.children : []),
          ]);
          detach(e.id);
          next.entries = next.entries.filter((x) => !ids.has(x.id));
          break;
        }
        case "set-bar-visible":
          if (typeof op.visible !== "boolean") throw Error("无效的显示偏好");
          next.barVisible = op.visible;
          break;
        default:
          throw Error("无效的收藏操作");
      }
      if (next.entries.length > BOOKMARK_MAX_ENTRIES)
        return bookmarkFailure(
          "LIMIT_EXCEEDED",
          "最多保存 5000 项收藏和文件夹",
        );
      validateSnapshot(next);
      if (isDeepStrictEqual(current, next))
        return {
          ok: true,
          snapshot: current,
          ...(affectedId ? { affectedId } : {}),
        };
      next.revision++;
      if (
        Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") >
        BOOKMARK_MAX_BYTES
      )
        return bookmarkFailure("LIMIT_EXCEEDED", "收藏容量超过 16 MiB");
    } catch (error) {
      return bookmarkFailure(
        error instanceof Error && error.message === "找不到收藏项目"
          ? "NOT_FOUND"
          : "INVALID_INPUT",
        "收藏输入或位置无效，请检查名称、网址和文件夹",
      );
    }
    try {
      this.write(this.file, next);
    } catch {
      return bookmarkFailure(
        "STORE_UNAVAILABLE",
        "收藏保存失败，原数据未改变，请重试",
      );
    }
    this.state = next;
    return {
      ok: true,
      snapshot: structuredClone(next),
      ...(affectedId ? { affectedId } : {}),
    };
  }
}
