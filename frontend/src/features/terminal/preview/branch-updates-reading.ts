import { useLayoutEffect, useRef } from "react";
import { useMemoizedFn } from "ahooks";
import { deviceStorage } from "../../device-storage";

type Position = { oid: string; offset: number; updatedAt: number };
const STORAGE_KEY = "runweave.branch-updates.positions.v1";
function positions(): Record<string, Position> {
  try {
    const value = JSON.parse(deviceStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Position] => {
      const item = entry[1] as Partial<Position> | null;
      return typeof item?.oid === "string" && Number.isFinite(item.offset) && Number.isFinite(item.updatedAt);
    }));
  }
  catch { return {}; }
}

export function useBranchUpdatesReading(key: string, revision: string | undefined) {
  const scroll = useRef<HTMLDivElement>(null);
  const saved = useRef<Position | null>(null);
  const currentKey = useRef(key);
  const capture = useMemoizedFn(() => {
    const element = scroll.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("[data-commit-oid]")]
      .find((item) => item.getBoundingClientRect().bottom > top);
    if (row?.dataset.commitOid) saved.current = { oid: row.dataset.commitOid,
      offset: row.getBoundingClientRect().top - top, updatedAt: Date.now() };
  });
  const flush = useMemoizedFn(() => {
    if (!saved.current) return;
    try {
      const all = { ...positions(), [currentKey.current]: saved.current };
      deviceStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(
        Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 100),
      )));
    } catch { /* Reading remains available without local storage. */ }
  });
  useLayoutEffect(() => {
    currentKey.current = key;
    saved.current = positions()[key] ?? null;
    return flush;
  }, [key, flush]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !revision) return;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-commit-oid]")];
    const position = saved.current;
    const row = position && rows.find((item) => item.dataset.commitOid === position.oid);
    element.scrollTop = row && Number.isFinite(position.offset)
      ? element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset : 0;
  }, [key, revision]);
  useLayoutEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [flush]);
  return { scroll, capture };
}
