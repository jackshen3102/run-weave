import { useEffect, useId, useRef, type ClipboardEventHandler, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../components/ui/button";

export function SuijiPanel({
  title,
  description,
  children,
  onBack,
  busy = false,
  actions,
  feedback,
  onPaste,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onBack: () => void;
  busy?: boolean;
  actions?: ReactNode;
  feedback?: ReactNode;
  onPaste?: ClipboardEventHandler<HTMLElement>;
}) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-labelledby={id}
      onPaste={onPaste}
      className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background outline-none"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          onClick={onBack}
          aria-label="返回"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h2 id={id} className="min-w-0 truncate font-semibold">
          {title}
        </h2>
        {actions ? (
          <div className="ml-auto flex shrink-0 gap-2">{actions}</div>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
      {feedback}
    </section>
  );
}
