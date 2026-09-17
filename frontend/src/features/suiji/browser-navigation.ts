import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMemoizedFn } from "ahooks";
import { useLocation } from "react-router-dom";
import { normalizeTerminalBrowserUrl } from "../terminal/navigation/browser-url";
import { openTerminalBrowserUrl } from "../terminal/navigation/open-browser";
import { useTerminalPreviewStore } from "../terminal/preview/store";
import { useSuijiDrawer } from "./drawer-state";

export type SuijiOpenLink = (url: string, isCurrent: () => boolean) => void;

interface OpenFailure {
  url: string;
  message: string;
  isCurrent: () => boolean;
}

/** Coordinates the existing desktop browser; never owns a WebContents or website identity. */
export function useSuijiBrowserNavigation(closeDialog: () => void) {
  const location = useLocation();
  const currentLocation = useRef(location.key);
  currentLocation.current = location.key;
  const alive = useRef(true);
  const pending = useRef(false);
  const [failure, setFailure] = useState<OpenFailure | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const openLink = useMemoizedFn(
    async (url: string, isCurrent: () => boolean) => {
      if (pending.current || !isCurrent()) return;
      const route = currentLocation.current;
      const sourceValid = () =>
        alive.current && route === currentLocation.current && isCurrent();
      const normalized = normalizeTerminalBrowserUrl(url);
      if (!normalized.ok) {
        setFailure({ url, isCurrent: sourceValid, message: normalized.error });
        return;
      }
      pending.current = true;
      setFailure(null);
      let canRestore = sourceValid;
      try {
        if (!window.electronAPI?.terminalBrowserCreateTab) {
          if (!window.electronAPI?.openExternal)
            throw new Error("当前桌面版本无法打开链接，请复制地址后继续。");
          await window.electronAPI.openExternal(normalized.url);
          return;
        }
        const before = useTerminalPreviewStore.getState();
        const profileId = before.activeBrowserProfileId;
        const activationRevision = before.browserActivationRevision;
        // Close the native dialog and commit suppression changes before IPC can attach a view.
        flushSync(() => {
          closeDialog();
          useSuijiDrawer.getState().setOpen(false);
        });
        const drawerRevision = useSuijiDrawer.getState().revision;
        canRestore = () => {
          const preview = useTerminalPreviewStore.getState();
          return (
            sourceValid() &&
            useSuijiDrawer.getState().revision === drawerRevision &&
            preview.activeBrowserProfileId === profileId &&
            preview.browserActivationRevision === activationRevision
          );
        };
        if (!canRestore()) return;
        await openTerminalBrowserUrl({
          url: normalized.url,
          profileId,
          placement: { kind: "new-group" },
        });
        if (canRestore())
          useTerminalPreviewStore.getState().activateBrowser(profileId, null);
      } catch (error) {
        if (canRestore()) {
          useSuijiDrawer.getState().setOpen(true);
          setFailure({
            url,
            isCurrent: sourceValid,
            message:
              error instanceof Error
                ? error.message
                : "打开网页失败，请主动重试。",
          });
        }
      } finally {
        pending.current = false;
      }
    },
  );

  const openExternal = useMemoizedFn(async () => {
    if (
      !failure?.isCurrent() ||
      !window.electronAPI?.openExternal ||
      pending.current
    )
      return;
    pending.current = true;
    try {
      const target = normalizeTerminalBrowserUrl(failure.url);
      if (!target.ok) throw new Error(target.error);
      await window.electronAPI.openExternal(target.url);
      if (failure.isCurrent()) setFailure(null);
    } catch (error) {
      if (failure.isCurrent())
        setFailure({
          ...failure,
          message: error instanceof Error ? error.message : "外部打开失败。",
        });
    } finally {
      pending.current = false;
    }
  });

  return {
    openLink,
    failure: failure?.isCurrent() ? failure : null,
    retry: () => {
      if (failure?.isCurrent()) void openLink(failure.url, failure.isCurrent);
    },
    openExternal,
    dismissError: () => setFailure(null),
  };
}
