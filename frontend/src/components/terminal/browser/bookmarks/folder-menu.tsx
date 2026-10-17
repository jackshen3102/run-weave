import { Folder } from "lucide-react";
import type { BookmarkEntry } from "@runweave/shared/terminal-browser-bookmarks";
import { Popover, PopoverTrigger, PopoverContent } from "../../../ui/popover";
import { Button } from "../../../ui/button";
import { BookmarkItem } from "./item";
import type { BookmarkControls } from "./use-bookmarks";
export function BookmarkFolder({
  entry,
  bookmarks: b,
}: {
  entry: Extract<BookmarkEntry, { kind: "folder" }>;
  bookmarks: BookmarkControls;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex max-w-36 items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-accent"
          title={entry.title}
        >
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate">{entry.title}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="px-2 py-2 text-xs text-muted-foreground">
          {entry.title}
        </div>
        <div className="max-h-72 overflow-y-auto">
          {entry.children.map((id) => {
            const child = b.snapshot?.entries.find((e) => e.id === id);
            return child ? (
              <BookmarkItem key={id} entry={child} bookmarks={b} />
            ) : null;
          })}
          {entry.children.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              此文件夹为空
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={b.pending || Boolean(b.disabledReason)}
          className="mt-1 w-full text-xs"
          onClick={() => {
            void b.addCurrent(entry.id);
          }}
        >
          收藏当前网页到此处
        </Button>
      </PopoverContent>
    </Popover>
  );
}
