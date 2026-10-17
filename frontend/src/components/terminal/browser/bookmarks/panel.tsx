import { X, Plus } from "lucide-react";
import { useState } from "react";
import { bookmarkParent } from "@runweave/shared/terminal-browser-bookmarks";
import { Input } from "../../../ui/input";
import { Button } from "../../../ui/button";
import { BookmarkItem } from "./item";
import type { BookmarkControls } from "./use-bookmarks";
export function BookmarkPanel({
  bookmarks: b,
}: {
  bookmarks: BookmarkControls;
}) {
  const [query, setQuery] = useState("");
  if (!b.panelOpen) return null;
  const snapshot = b.snapshot;
  const q = query.trim().toLowerCase();
  const items = q
    ? snapshot?.entries.filter((e) =>
        (e.title + " " + (e.kind === "link" ? e.url : ""))
          .toLowerCase()
          .includes(q),
      )
    : snapshot?.rootIds.flatMap((id) => {
        const e = snapshot.entries.find((x) => x.id === id);
        return e ? [e] : [];
      });
  return (
    <aside
      className="absolute inset-y-0 right-0 flex w-80 flex-col border-l border-slate-800 bg-slate-950"
      aria-label="收藏夹面板"
      onKeyDown={(event) => {
        if (event.key === "Escape") b.setPanelOpen(false);
      }}
    >
      <header className="flex items-center justify-between px-3 py-3 text-sm font-medium">
        收藏夹
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          aria-label="关闭收藏夹"
          onClick={() => b.setPanelOpen(false)}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="px-3 pb-3">
        <Input
          aria-label="搜索收藏"
          placeholder="搜索名称或网址"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {items?.map((entry) => (
          <div key={entry.id}>
            <BookmarkItem entry={entry} bookmarks={b} detail draggable={!q} />
            {q && snapshot && bookmarkParent(snapshot, entry.id) ? (
              <p className="px-8 pb-1 text-xs text-muted-foreground">
                {
                  snapshot.entries.find(
                    (e) => e.id === bookmarkParent(snapshot, entry.id),
                  )?.title
                }
              </p>
            ) : null}
            {!q && entry.kind === "folder" ? (
              <div className="pl-4">
                {entry.children.map((id) => {
                  const child = snapshot?.entries.find((e) => e.id === id);
                  return child ? (
                    <BookmarkItem key={id} entry={child} bookmarks={b} detail />
                  ) : null;
                })}
              </div>
            ) : null}
          </div>
        ))}
        {items?.length === 0 ? (
          <p className="p-5 text-center text-xs text-muted-foreground">
            {q ? "没有找到匹配的收藏" : "还没有收藏的网页"}
          </p>
        ) : null}
      </div>
      <footer className="flex items-center justify-between border-t border-slate-800 p-2">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-xs"
          onClick={b.newFolder}
        >
          <Plus className="size-3.5" />
          新建文件夹
        </Button>
        <span className="pr-2 text-xs text-muted-foreground">
          {snapshot?.entries.filter((e) => e.kind === "link").length ?? 0}{" "}
          项收藏
        </span>
      </footer>
    </aside>
  );
}
