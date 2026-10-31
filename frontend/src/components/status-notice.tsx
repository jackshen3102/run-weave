import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useMemoizedFn } from "ahooks";
import { X } from "lucide-react";
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

export function StatusNotice({ children, className, kind, onDismiss, noticeKey, duration = 8_000, role = "status" }: {
  children: ReactNode;
  className: string;
  kind: string;
  onDismiss: () => void;
  noticeKey?: unknown;
  /** Set to zero when the notice contains information the user needs to copy. */
  duration?: number;
  role?: "status" | "alert";
}) {
  const viewport = useContext(NoticeViewport);
  const ref = useOverlayRef<HTMLDivElement>();
  const dismiss = useMemoizedFn(onDismiss);
  useEffect(() => {
    if (!viewport || duration <= 0) return;
    const timer = window.setTimeout(dismiss, duration);
    return () => window.clearTimeout(timer);
  }, [viewport, duration, noticeKey, dismiss]);
  return viewport ? createPortal(
    <div ref={ref} role={role} aria-live={role === "alert" ? "assertive" : "polite"} data-status-notice={kind}
      className={`pointer-events-auto relative shrink-0 break-words ${className} pr-10`}>
      {children}
      <button type="button" aria-label="关闭通知" onClick={dismiss}
        className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <X className="h-4 w-4" />
      </button>
    </div>,
    viewport,
  ) : null;
}
