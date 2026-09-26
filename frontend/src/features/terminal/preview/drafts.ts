import { deviceStorage } from "../../device-storage";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface PreviewDraft {
  editorContent: string;
  loadedContent: string;
  loadedMtimeMs: number;
  savedAt: number;
}

interface PreviewDraftStore {
  drafts: Record<string, PreviewDraft>;
  put: (key: string, draft: PreviewDraft) => void;
  remove: (key: string) => void;
}

export function previewDraftKey(connectionId: string | null, projectId: string | null, path: string | null): string | null {
  return connectionId && projectId && path ? JSON.stringify([connectionId, projectId, path]) : null;
}

export const usePreviewDrafts = create<PreviewDraftStore>()(persist((set) => ({
  drafts: {},
  put: (key, draft) => set((state) => {
    const entries = Object.entries({ ...state.drafts, [key]: draft })
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, 20);
    return { drafts: Object.fromEntries(entries) };
  }),
  remove: (key) => set((state) => {
    if (!(key in state.drafts)) return state;
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  }),
}), { storage: createJSONStorage(() => deviceStorage), name: "runweave.terminal.preview.drafts.v1", version: 1, partialize: (state) => ({ drafts: state.drafts }) }));
