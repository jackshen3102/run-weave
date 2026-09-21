import { create } from "zustand";
import { HttpError } from "../../../services/http";
import { createTerminalSnapshotShare } from "../../../services/terminal/snapshot-share";

interface SnapshotShareState {
  pending: boolean;
  result: { url: string; copied: boolean } | null;
  error: string | null;
  createShare: (apiBase: string, token: string, sessionId: string, panelId: string) => Promise<void>;
  dismiss: () => void;
}

// Memory-only: a connection switch can unmount the terminal, but must not lose
// a successfully created link. Never persist bearer links in browser storage.
export const useSnapshotShareStore = create<SnapshotShareState>((set, get) => ({
  pending: false,
  result: null,
  error: null,
  dismiss: () => set({ result: null, error: null }),
  createShare: async (apiBase, token, sessionId, panelId) => {
    if (get().pending) return;
    set({ pending: true, result: null, error: null });
    try {
      const result = await createTerminalSnapshotShare(apiBase, token, sessionId, panelId);
      let copied = false;
      try {
        await navigator.clipboard.writeText(result.url);
        copied = true;
      } catch {
        // Keep the link even when the browser denies clipboard access.
      }
      set({ result: { url: result.url, copied } });
    } catch (error) {
      // Do not retain or log fetch errors that could contain credentials/URLs.
      if (error instanceof HttpError && error.message === "Public snapshot publishing is not configured") {
        set({ error: "当前 Backend 尚未配置公网分享服务，请配置后重试。" });
        return;
      }
      set({ error: error instanceof HttpError
        ? `创建终端快照失败（HTTP ${error.status}）`
        : "创建终端快照失败，请检查 HTTP(S) 连接后重试。" });
    } finally {
      set({ pending: false });
    }
  },
}));
