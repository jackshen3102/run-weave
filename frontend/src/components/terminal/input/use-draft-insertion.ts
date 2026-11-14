import { useMemoizedFn } from "ahooks";
import type { MutableRefObject } from "react";

interface DraftInsertionOptions {
  eligible: boolean;
  draftMirrorSupported: boolean;
  floatingDraftSyncPendingRef: MutableRefObject<boolean>;
  floatingDraftRef: MutableRefObject<string>;
  setSendError: (error: string) => void;
  setFloatingComposerOpen: (open: boolean) => void;
  handleDraftChange: (value: string) => void;
}

export function useDraftInsertion({
  eligible,
  draftMirrorSupported,
  floatingDraftSyncPendingRef,
  floatingDraftRef,
  setSendError,
  setFloatingComposerOpen,
  handleDraftChange,
}: DraftInsertionOptions) {
  return useMemoizedFn((text: string) => {
    if (!eligible || !draftMirrorSupported || floatingDraftSyncPendingRef.current) {
      setSendError("输入框暂不可用，未插入选区，请稍后重试。");
      setFloatingComposerOpen(true);
      return false;
    }
    const current = floatingDraftRef.current;
    handleDraftChange(`${current}${current && !current.endsWith("\n") ? "\n" : ""}${text}\n`);
    setFloatingComposerOpen(true);
    return true;
  });
}
