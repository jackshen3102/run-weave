import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

export function WorkHistoryLayout({
  list,
  journal,
  inspector,
  inspectorOpen,
  onCloseInspector,
  mobileDetailOpen,
  mobileDetailLabel,
  onCloseMobileDetail,
}: {
  list: ReactNode;
  journal: ReactNode;
  inspector: ReactNode;
  inspectorOpen: boolean;
  onCloseInspector: () => void;
  mobileDetailOpen: boolean;
  mobileDetailLabel: string;
  onCloseMobileDetail: () => void;
}) {
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(() =>
    window.matchMedia("(max-width: 1379px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1379px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (!inspectorOpen) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseInspector();
      if (
        event.key === "Tab" &&
        window.matchMedia("(max-width: 1379px)").matches
      ) {
        const focusable = [...(inspectorRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [])].filter((element) => !element.hasAttribute("disabled"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const focusFrame = window.requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1379px)").matches) {
        inspectorRef.current?.querySelector<HTMLElement>("button")?.focus();
      }
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(focusFrame);
      restoreFocusRef.current?.focus();
    };
  }, [inspectorOpen, onCloseInspector]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] overflow-hidden rounded-xl border border-border/70 bg-card/50 min-[1380px]:grid-cols-[300px_minmax(0,1fr)_380px] max-md:grid-cols-1">
      <section
        className={`${mobileDetailOpen ? "max-md:hidden" : ""} min-h-0 min-w-0 overflow-auto border-r border-border/70 max-md:border-r-0`}
      >
        {list}
      </section>
      <section
        className={`${mobileDetailOpen ? "" : "max-md:hidden"} min-h-0 min-w-0 overflow-auto`}
      >
        <div className="sticky top-0 z-10 hidden border-b border-border/70 bg-background/95 px-3 py-2 backdrop-blur max-md:block">
          <button
            type="button"
            className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted"
            onClick={onCloseMobileDetail}
          >
            <ArrowLeft className="h-4 w-4" />
            {mobileDetailLabel}
          </button>
        </div>
        {journal}
      </section>
      <aside
        ref={inspectorRef}
        className={`${inspectorOpen ? "block" : "hidden"} min-h-0 overflow-auto border-l border-border/70 bg-background min-[1380px]:block max-[1379px]:fixed max-[1379px]:inset-y-0 max-[1379px]:right-0 max-[1379px]:z-50 max-[1379px]:w-[min(92vw,420px)] max-[1379px]:shadow-2xl`}
        aria-label="Work history inspector"
        aria-modal={inspectorOpen && narrow ? true : undefined}
        role={inspectorOpen && narrow ? "dialog" : "complementary"}
      >
        {inspector}
      </aside>
      {inspectorOpen ? (
        <button
          type="button"
          aria-label="Close inspector"
          className="fixed inset-0 z-40 bg-black/35 min-[1380px]:hidden"
          onClick={onCloseInspector}
        />
      ) : null}
    </div>
  );
}
