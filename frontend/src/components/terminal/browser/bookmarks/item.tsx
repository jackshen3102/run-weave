import { Folder, Globe, MoreHorizontal } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import type { BookmarkEntry } from "@runweave/shared/terminal-browser-bookmarks";
import { bookmarkParent } from "@runweave/shared/terminal-browser-bookmarks";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "../../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "../../../ui/dropdown-menu";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { BookmarkControls } from "./use-bookmarks";
const dragType = "application/x-runweave-bookmark";
export function BookmarkIcon({ entry }: { entry: BookmarkEntry }) {
  return entry.kind === "folder" ? (
    <Folder className="size-3.5 shrink-0" />
  ) : entry.faviconDataUrl ? (
    <img src={entry.faviconDataUrl} alt="" className="size-3.5 shrink-0" />
  ) : (
    <Globe className="size-3.5 shrink-0" />
  );
}
export function BookmarkItem({
  entry,
  bookmarks: b,
  children,
  draggable = true,
  detail = false,
}: {
  entry: BookmarkEntry;
  bookmarks: BookmarkControls;
  children?: ReactNode;
  draggable?: boolean;
  detail?: boolean;
}) {
  const [drop, setDrop] = useState<"before" | "after" | "inside" | null>(null);
  const contextItems = (
    <>
      {entry.kind === "link" ? (
        <ContextMenuItem
          onSelect={() => {
            void b.open(entry, true).catch(() => b.setMessage("打开收藏失败"));
          }}
        >
          在新标签页打开
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onSelect={() => b.edit(entry)}>
        {entry.kind === "folder" ? "重命名文件夹" : "编辑收藏"}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={b.pending}
        onSelect={() => {
          void b.remove(entry);
        }}
      >
        删除{entry.kind === "folder" ? "文件夹" : ""}
      </ContextMenuItem>
    </>
  );
  const locate = (event: DragEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    const ratio = detail
      ? (event.clientY - r.top) / r.height
      : (event.clientX - r.left) / r.width;
    return entry.kind === "folder" && ratio > 0.25 && ratio < 0.75
      ? "inside"
      : ratio < 0.5
        ? "before"
        : "after";
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(dragType);
    const position = locate(event);
    setDrop(null);
    if (!id || id === entry.id || !b.snapshot) return;
    let parentId = bookmarkParent(b.snapshot, entry.id);
    let beforeId: string | null = entry.id;
    if (position === "inside") {
      parentId = entry.id;
      beforeId = null;
    } else if (position === "after") {
      const folder = b.snapshot.entries.find((x) => x.id === parentId);
      const ids =
        folder?.kind === "folder" ? folder.children : b.snapshot.rootIds;
      beforeId = ids[ids.indexOf(entry.id) + 1] ?? null;
    }
    void b.move(id, parentId, beforeId);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-bookmark-id={entry.id}
          draggable={draggable && !b.pending}
          className={cn(
            "group flex min-w-0 items-center rounded",
            detail ? "w-full" : "max-w-36 shrink-0",
            drop === "inside" && "bg-accent",
            drop === "before" && "border-l-2 border-primary",
            drop === "after" && "border-r-2 border-primary",
          )}
          onDragStart={(event) => {
            event.dataTransfer.setData(dragType, entry.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (draggable && event.dataTransfer.types.includes(dragType)) {
              event.preventDefault();
              setDrop(locate(event));
            }
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={draggable ? onDrop : undefined}
        >
          {children ?? (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              title={
                entry.kind === "link"
                  ? `${entry.title}\n${entry.url}`
                  : entry.title
              }
              onClick={() => {
                if (entry.kind === "link")
                  void b.open(entry).catch(() => b.setMessage("打开收藏失败"));
              }}
            >
              <BookmarkIcon entry={entry} />
              <span className="min-w-0 truncate">
                {entry.title}
                {detail && entry.kind === "link" ? (
                  <small className="mt-1 block truncate text-muted-foreground">
                    {entry.url}
                  </small>
                ) : null}
              </span>
            </button>
          )}
          {detail ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 shrink-0 p-0"
                  aria-label={`管理 ${entry.title}`}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {entry.kind === "link" ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        void b
                          .open(entry, true)
                          .catch(() => b.setMessage("打开收藏失败"));
                      }}
                    >
                      在新标签页打开
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => b.edit(entry)}>
                    编辑
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={b.pending}
                    onSelect={() => {
                      void b.remove(entry);
                    }}
                  >
                    删除
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>{contextItems}</ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
