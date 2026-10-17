import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import {
  bookmarkParent,
  bookmarkUrl,
  type BookmarkEntry,
  type BookmarkLink,
} from "@runweave/shared/terminal-browser-bookmarks";
import { parseLocalBrowserTarget } from "@runweave/shared/browser-local-tunnel";
import type { TerminalBrowserTabState } from "../../../../features/terminal/preview/store";
import {
  bookmarksSupported,
  useBookmarkStore,
} from "../../../../features/terminal/bookmarks/store";
interface Editor {
  id: string;
  title: string;
  url: string;
  parentId: string | null;
  fresh: boolean;
}
interface Options {
  active: boolean;
  tab: TerminalBrowserTabState | undefined;
  profileId: string;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  navigate: (url: string) => Promise<void>;
  createTab: (url: string) => Promise<void>;
}
export function useBookmarks(options: Options) {
  const { snapshot, error, pending, refresh, accept, mutate } =
    useBookmarkStore();
  const supported = bookmarksSupported();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [folderEditor, setFolderEditor] = useState<{
    id?: string;
    title: string;
    returnToEditor?: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<BookmarkEntry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureLock = useRef(false);
  const identity = `${options.active}:${options.profileId}:${options.tab?.id ?? ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    if (!supported) return;
    const unsubscribe =
      window.electronAPI!.onTerminalBrowserBookmarksChanged!(accept);
    void refresh();
    return unsubscribe;
  }, [supported, refresh, accept]);
  useEffect(() => {
    setEditor(null);
    setFolderEditor(null);
    setDeleting(null);
  }, [identity]);
  const edit = useMemoizedFn((entry: BookmarkEntry) => {
    setMessage(null);
    if (entry.kind === "folder")
      setFolderEditor({ id: entry.id, title: entry.title });
    else if (snapshot)
      setEditor({
        id: entry.id,
        title: entry.title,
        url: entry.url,
        parentId: bookmarkParent(snapshot, entry.id),
        fresh: false,
      });
  });
  const addCurrent = useMemoizedFn(async (parentId?: string) => {
    if (!options.tab || !options.active || pending || captureLock.current)
      return;
    const currentIdentity = identity;
    captureLock.current = true;
    setCapturing(true);
    setMessage(null);
    try {
      const target = await window.electronAPI!
        .terminalBrowserGetBookmarkTarget!(options.tab.id);
      if (currentIdentity !== identityRef.current) return;
      if (!target.ok) {
        setMessage(target.error.message);
        return;
      }
      const existing = useBookmarkStore
        .getState()
        .snapshot?.entries.find(
          (e) => e.kind === "link" && e.url === target.target.url,
        );
      if (existing?.kind === "link") {
        const current = useBookmarkStore.getState().snapshot!;
        setEditor({
          id: existing.id,
          title: existing.title,
          url: existing.url,
          parentId: parentId ?? bookmarkParent(current, existing.id),
          fresh: false,
        });
        return;
      }
      const result = await mutate({
        kind: "add-link",
        ...target.target,
        parentId: parentId ?? null,
      });
      if (currentIdentity !== identityRef.current) return;
      if (result.ok) {
        const entry = result.snapshot.entries.find(
          (e) => e.id === result.affectedId,
        );
        if (entry?.kind === "link")
          setEditor({
            id: entry.id,
            title: entry.title,
            url: entry.url,
            parentId: bookmarkParent(result.snapshot, entry.id),
            fresh: true,
          });
      }
    } catch {
      setMessage("无法读取当前网页，请重试");
    } finally {
      captureLock.current = false;
      setCapturing(false);
    }
  });
  const saveEditor = useMemoizedFn(async () => {
    if (!editor) return;
    const result = await mutate({
      kind: "edit-link",
      id: editor.id,
      title: editor.title,
      url: editor.url,
      parentId: editor.parentId,
    });
    if (result.ok) {
      setEditor(null);
      setMessage("收藏已保存");
    }
  });
  const saveFolder = useMemoizedFn(async () => {
    if (!folderEditor) return;
    const result = await mutate(
      folderEditor.id
        ? {
            kind: "rename-folder",
            id: folderEditor.id,
            title: folderEditor.title,
          }
        : { kind: "add-folder", title: folderEditor.title },
    );
    if (result.ok) {
      if (folderEditor.returnToEditor)
        setEditor((e) =>
          e ? { ...e, parentId: result.affectedId ?? e.parentId } : e,
        );
      setFolderEditor(null);
      setMessage("文件夹已保存");
    }
  });
  const remove = useMemoizedFn(
    async (entry: BookmarkEntry, confirmed = false) => {
      if (entry.kind === "folder" && entry.children.length && !confirmed) {
        setDeleting(entry);
        return;
      }
      const result = await mutate({
        kind: "delete",
        id: entry.id,
        includeChildren: confirmed,
      });
      if (result.ok) {
        setDeleting(null);
        if (editor?.id === entry.id) setEditor(null);
        setMessage("已删除收藏");
      }
    },
  );
  const open = useMemoizedFn(async (entry: BookmarkLink, newTab = false) => {
    const currentIdentity = identity;
    const result = await window.electronAPI!.terminalBrowserGetBookmarks!();
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    accept(result.snapshot);
    const latest = result.snapshot.entries.find((e) => e.id === entry.id);
    if (!latest || latest.kind !== "link") {
      setMessage("该收藏已删除");
      return;
    }
    if (identityRef.current !== currentIdentity) return;
    if (
      newTab ||
      Boolean(options.tab?.localPreview && parseLocalBrowserTarget(latest.url))
    ) {
      await options.createTab(latest.url);
      if (!newTab) setMessage("已在本机新标签页打开");
    } else await options.navigate(latest.url);
  });
  const move = useMemoizedFn(
    async (id: string, parentId: string | null, beforeId: string | null) => {
      await mutate({ kind: "move", id, parentId, beforeId });
    },
  );
  let current: BookmarkLink | undefined;
  try {
    const url = bookmarkUrl(options.tab?.url);
    current = snapshot?.entries.find(
      (e): e is BookmarkLink => e.kind === "link" && e.url === url,
    );
  } catch {
    /* Blank and temporary pages have no bookmark state. */
  }
  return {
    supported,
    snapshot,
    error,
    pending: pending || capturing,
    refresh,
    editor,
    setEditor,
    folderEditor,
    setFolderEditor,
    deleting,
    setDeleting,
    message,
    setMessage,
    current,
    panelOpen: options.panelOpen,
    setPanelOpen: options.setPanelOpen,
    edit,
    addCurrent,
    saveEditor,
    saveFolder,
    remove,
    open,
    move,
    toggleBar: () => {
      if (snapshot)
        void mutate({ kind: "set-bar-visible", visible: !snapshot.barVisible });
    },
    newFolder: () => setFolderEditor({ title: "" }),
    disabledReason: options.tab?.localPreview
      ? "临时预览暂不支持收藏"
      : !options.tab || !/^https?:/.test(options.tab.url)
        ? "此页面暂不支持收藏"
        : null,
  };
}
export type BookmarkControls = ReturnType<typeof useBookmarks>;
