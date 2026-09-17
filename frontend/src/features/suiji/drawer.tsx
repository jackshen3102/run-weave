import { lazy, Suspense, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useSuijiBrowserNavigation } from "./browser-navigation";
import { useSuijiDrawer } from "./drawer-state";
const SuijiPage = lazy(() => import("./connection"));

export function SuijiDrawer() {
  const { open, opened, setOpen } = useSuijiDrawer();
  const dialog = useRef<HTMLDialogElement>(null);
  const browser = useSuijiBrowserNavigation(() => dialog.current?.close());
  const location = useLocation();
  useEffect(() => {
    if (!location.pathname.startsWith("/terminal")) setOpen(false);
  }, [location.pathname, setOpen]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-label="随记抽屉"
      aria-modal="true"
      className="suiji-drawer fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[480px] max-w-full overflow-hidden border-0 border-l bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/30"
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          event.clientX < event.currentTarget.getBoundingClientRect().left
        )
          setOpen(false);
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {browser.failure ? (
          <div role="alert" className="shrink-0 space-y-2 border-b p-4 text-sm">
            <p>打开网页失败：{browser.failure.message}</p>
            <p>请求结果可能未确认，请先检查 Browser 中是否已打开。</p>
            <div className="flex gap-3">
              <button type="button" onClick={browser.retry}>
                重试打开
              </button>
              {window.electronAPI?.openExternal ? (
                <button
                  type="button"
                  onClick={() => void browser.openExternal()}
                >
                  在默认浏览器打开
                </button>
              ) : null}
              <button type="button" onClick={browser.dismissError}>
                关闭提示
              </button>
            </div>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {opened ? (
            <Suspense
              fallback={
                <p role="status" className="p-5">
                  正在打开随记…
                </p>
              }
            >
              <SuijiPage
                onClose={() => setOpen(false)}
                onOpenLink={browser.openLink}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
