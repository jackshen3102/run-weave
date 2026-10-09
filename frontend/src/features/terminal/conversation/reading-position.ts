import { useLayoutEffect, useRef } from "react";
import { useMemoizedFn } from "ahooks";
import { deviceStorage } from "../../device-storage";

type Anchor = { candidates: Array<{ id: string; offset: number }>; top: number };
type SavedPosition = Anchor & { updatedAt: number };
const STORAGE_KEY = "runweave.terminal.conversation.positions.v1";

function readPositions(): Record<string, SavedPosition> {
  try { return JSON.parse(deviceStorage.getItem(STORAGE_KEY) ?? "{}") ?? {}; }
  catch { return {}; }
}

function readPosition(key: string): Anchor | null {
  const saved = readPositions()[key];
  return saved && Number.isFinite(saved.top) && Array.isArray(saved.candidates)
    && saved.candidates.every((item) => typeof item?.id === "string" && Number.isFinite(item.offset))
    ? saved : null;
}

export function useConversationReadingPosition(key: string | null, revision: string | undefined) {
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const activeKey = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredTop = useRef<number | null>(null);
  const dirty = useRef(false);
  const flush = useMemoizedFn(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current || !activeKey.current || !anchor.current) return;
    try {
      const positions = { ...readPositions(), [activeKey.current]: { ...anchor.current, updatedAt: Date.now() } };
      deviceStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(
        Object.entries(positions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 100),
      )));
      dirty.current = false;
    } catch { /* A full or unavailable store must not prevent reading. */ }
  });
  const capture = useMemoizedFn(() => {
    const element = scroll.current;
    if (!element || !activeKey.current) return;
    // Layout restoration can clamp while Markdown/images are still growing.
    // Keep the original anchor until the reader actually changes the position.
    if (restoredTop.current !== null && Math.abs(element.scrollTop - restoredTop.current) < 1) return;
    restoredTop.current = null;
    const top = element.getBoundingClientRect().top;
    const messages = Array.from(element.querySelectorAll<HTMLElement>("[data-conversation-message]"));
    const first = messages.findIndex((message) => message.getBoundingClientRect().bottom > top);
    if (first < 0) return;
    anchor.current = { top: element.scrollTop, candidates: messages.slice(Math.max(0, first - 7), first + 1).reverse().map((message) => ({
      id: message.dataset.conversationMessage!, offset: message.getBoundingClientRect().top - top,
    })) };
    dirty.current = true;
    if (!timer.current) timer.current = setTimeout(flush, 250);
  });
  const restore = useMemoizedFn(() => {
    const element = scroll.current;
    const saved = anchor.current;
    if (!element || !saved) return;
    const messages = Array.from(element.querySelectorAll<HTMLElement>("[data-conversation-message]"));
    if (!messages.length) return;
    const candidate = saved.candidates.find((item) => messages.some((message) => message.dataset.conversationMessage === item.id));
    const message = candidate && messages.find((item) => item.dataset.conversationMessage === candidate.id);
    element.scrollTop = message && candidate
      ? element.scrollTop + message.getBoundingClientRect().top - element.getBoundingClientRect().top - candidate.offset
      : saved.top;
    restoredTop.current = element.scrollTop;
  });
  useLayoutEffect(() => {
    flush();
    activeKey.current = key;
    anchor.current = key ? readPosition(key) : null;
    restoredTop.current = null;
    dirty.current = false;
    return flush;
  }, [key, flush]);
  useLayoutEffect(() => {
    restore();
    const body = scroll.current?.firstElementChild;
    if (!body) return;
    const observer = new ResizeObserver(restore);
    observer.observe(body);
    return () => observer.disconnect();
  }, [key, revision, restore]);
  useLayoutEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [flush]);
  const latest = useMemoizedFn(() => {
    const element = scroll.current;
    if (!element) return;
    restoredTop.current = null;
    element.scrollTop = element.scrollHeight;
    capture();
    flush();
  });
  return { scroll, capture, latest };
}
