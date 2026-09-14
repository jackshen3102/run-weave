import { lazy, Suspense, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useSuijiDrawer } from "./drawer-state";
const SuijiPage = lazy(() => import("./connection"));

export function SuijiDrawer() {
  const { open, opened, setOpen } = useSuijiDrawer();
  const dialog = useRef<HTMLDialogElement>(null);
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
      {opened ? (
        <Suspense
          fallback={
            <p role="status" className="p-5">
              正在打开随记…
            </p>
          }
        >
          <SuijiPage onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </dialog>
  );
}
