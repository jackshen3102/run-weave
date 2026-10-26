import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOverlayRef } from "../features/overlay/use-overlay-ref";

const NoticeViewport = createContext<HTMLDivElement | null>(null);

export function StatusNoticeProvider({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <NoticeViewport.Provider value={viewport}>
      {children}
      <div
        ref={setViewport}
        data-status-notice-viewport=""
        className="pointer-events-none fixed bottom-4 left-4 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto"
      />
    </NoticeViewport.Provider>
  );
}

export function StatusNotice({ children, className, kind }: {
  children: ReactNode;
  className: string;
  kind: string;
}) {
  const viewport = useContext(NoticeViewport);
  const ref = useOverlayRef<HTMLDivElement>();
  return viewport ? createPortal(
    <div ref={ref} role="status" aria-live="polite" data-status-notice={kind}
      className={`pointer-events-auto shrink-0 break-words ${className}`}>
      {children}
    </div>,
    viewport,
  ) : null;
}
