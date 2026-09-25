import { useOverlayRef } from "../../features/overlay/use-overlay-ref";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Tooltip({
  align = "center",
  children,
  className,
  content,
  side = "bottom",
}: {
  align?: "center" | "end" | "start";
  children: ReactNode;
  className?: string;
  content: ReactNode;
  side?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const overlayRef = useOverlayRef<HTMLSpanElement>(undefined, "intersection", open);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onBlurCapture={() => setOpen(false)}
      onClickCapture={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onPointerDownCapture={() => setOpen(false)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      {children}
      <span
        ref={overlayRef}
        role="tooltip"
        aria-hidden={!open}
        className={cn(
          "pointer-events-none absolute z-[80] w-max max-w-64 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] font-normal leading-4 text-slate-200 shadow-lg transition-opacity delay-150",
          open ? "visible opacity-100" : "invisible opacity-0",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "start" && "left-0",
          align === "end" && "right-0",
          side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
        )}
      >
        {content}
      </span>
    </span>
  );
}
