import { create } from "zustand";
import type {
  BookmarkOperation,
  BookmarkResult,
  BookmarkSnapshot,
} from "@runweave/shared/terminal-browser-bookmarks";
interface BookmarkState {
  snapshot: BookmarkSnapshot | null;
  error: string | null;
  pending: boolean;
  refresh: () => Promise<void>;
  accept: (snapshot: BookmarkSnapshot) => void;
  mutate: (operation: BookmarkOperation) => Promise<BookmarkResult>;
}
export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  snapshot: null,
  error: null,
  pending: false,
  accept: (snapshot) =>
    set((state) =>
      !state.snapshot || snapshot.revision >= state.snapshot.revision
        ? { snapshot, error: null }
        : {},
    ),
  refresh: async () => {
    try {
      const result = await window.electronAPI!.terminalBrowserGetBookmarks!();
      if (result.ok) get().accept(result.snapshot);
      else set({ error: result.error.message });
    } catch {
      set({ error: "无法读取收藏夹，请重试" });
    }
  },
  mutate: async (operation) => {
    const snapshot = get().snapshot;
    if (!snapshot || get().pending)
      return {
        ok: false,
        error: {
          code: "STORE_UNAVAILABLE",
          message: "收藏尚未就绪，请稍后重试",
        },
      };
    set({ pending: true, error: null });
    try {
      const result = await window.electronAPI!.terminalBrowserMutateBookmarks!({
        expectedRevision: snapshot.revision,
        operation,
      });
      if (result.snapshot) get().accept(result.snapshot);
      if (!result.ok) set({ error: result.error.message });
      return result;
    } catch {
      await get().refresh();
      const message = "保存结果尚未确认，请核对收藏后再重试";
      set({ error: message });
      return { ok: false, error: { code: "STORE_UNAVAILABLE", message } };
    } finally {
      set({ pending: false });
    }
  },
}));
export function bookmarksSupported(): boolean {
  const api = window.electronAPI;
  return Boolean(
    api?.isElectron &&
    api.terminalBrowserGetBookmarks &&
    api.terminalBrowserMutateBookmarks &&
    api.terminalBrowserGetBookmarkTarget &&
    api.onTerminalBrowserBookmarksChanged,
  );
}
