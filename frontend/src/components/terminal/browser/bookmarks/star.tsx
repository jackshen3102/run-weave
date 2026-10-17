import { Star } from "lucide-react";
import { Button } from "../../../ui/button";
import type { BookmarkControls } from "./use-bookmarks";
export function BookmarkStar({
  bookmarks: b,
}: {
  bookmarks: BookmarkControls;
}) {
  if (!b.supported) return null;
  const label = b.current ? "编辑当前收藏" : "收藏当前网页";
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 w-7 rounded-md px-0"
      disabled={b.pending || Boolean(b.disabledReason) || !b.snapshot}
      title={b.disabledReason ?? label}
      aria-label={label}
      onClick={() => void b.addCurrent()}
    >
      <Star
        className={b.current ? "h-4 w-4 fill-sky-400 text-sky-400" : "h-4 w-4"}
      />
    </Button>
  );
}
export function BookmarkFeedback({
  bookmarks: b,
}: {
  bookmarks: BookmarkControls;
}) {
  if (!b.supported || (!b.error && !b.message)) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1 text-xs text-slate-300"
    >
      {b.error || b.message}
      {b.error ? (
        <button className="text-sky-300" onClick={() => void b.refresh()}>
          重试
        </button>
      ) : (
        <button aria-label="关闭收藏提示" onClick={() => b.setMessage(null)}>
          ×
        </button>
      )}
    </div>
  );
}
