import { BookOpen, ChevronsRight } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../../../ui/popover";
import { Button } from "../../../ui/button";
import { BookmarkItem, BookmarkIcon } from "./item";
import { BookmarkFolder } from "./folder-menu";
import type { BookmarkControls } from "./use-bookmarks";
export function BookmarkBar({ bookmarks: b }: { bookmarks: BookmarkControls }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const items = useMemo(
    () =>
      b.snapshot?.rootIds.flatMap((id) => {
        const e = b.snapshot?.entries.find((x) => x.id === id);
        return e ? [e] : [];
      }) ?? [],
    [b.snapshot],
  );
  useLayoutEffect(() => {
    const container = box.current;
    const sizing = measure.current;
    if (!container || !sizing) return;
    const fit = () => {
      let width = 0;
      let n = 0;
      for (const child of sizing.children) {
        width += child.getBoundingClientRect().width + 2;
        if (width > container.clientWidth) break;
        n++;
      }
      setCount(n);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(sizing);
    fit();
    return () => observer.disconnect();
  }, [items, b.snapshot?.barVisible]);
  if (!b.supported || !b.snapshot?.barVisible) return null;
  const renderItem = (entry: (typeof items)[number]) => (
    <BookmarkItem key={entry.id} entry={entry} bookmarks={b}>
      {entry.kind === "folder" ? (
        <BookmarkFolder entry={entry} bookmarks={b} />
      ) : undefined}
    </BookmarkItem>
  );
  return (
    <div
      className="relative flex h-8 shrink-0 items-center gap-0.5 border-b border-slate-800 px-2"
      aria-label="收藏栏"
    >
      <div
        ref={box}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      >
        {items.slice(0, count).map(renderItem)}
      </div>
      <div
        ref={measure}
        aria-hidden="true"
        className="pointer-events-none invisible absolute flex w-max items-center gap-0.5"
      >
        {items.map((entry) => (
          <span
            key={entry.id}
            className="flex max-w-36 items-center gap-2 px-2 py-1.5 text-xs"
          >
            <BookmarkIcon entry={entry} />
            <span className="truncate">{entry.title}</span>
          </span>
        ))}
      </div>
      {count < items.length ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="size-6 shrink-0 p-0"
              aria-label="更多收藏"
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="max-h-96 w-64 overflow-y-auto" align="end">
            {items.slice(count).map(renderItem)}
          </PopoverContent>
        </Popover>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 gap-1.5 px-2 text-xs"
        onClick={() => b.setPanelOpen(!b.panelOpen)}
        aria-label="收藏夹"
      >
        <BookOpen className="size-3.5" />
        收藏夹
      </Button>
    </div>
  );
}
