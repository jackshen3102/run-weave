import { ExternalLink, MessageSquare, Send } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet";
import type { MobileTerminalCardViewModel } from "./terminal-card-view-model";
import { HermesHandoffPreview } from "./HermesHandoffPreview";

interface TerminalDetailDrawerProps {
  terminal: MobileTerminalCardViewModel | null;
  mode: "detail" | "handoff";
  copied: boolean;
  copyError: string | null;
  onModeChange: (mode: "detail" | "handoff") => void;
  onOpenChange: (open: boolean) => void;
  onCopy: () => Promise<void>;
  onCopyAndPromptFeishu: () => Promise<void>;
  onOpenFullTerminal: (terminalSessionId: string) => void;
}

export function TerminalDetailDrawer({
  terminal,
  mode,
  copied,
  copyError,
  onModeChange,
  onOpenChange,
  onCopy,
  onCopyAndPromptFeishu,
  onOpenFullTerminal,
}: TerminalDetailDrawerProps) {
  const open = terminal !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-t-2xl border-border/60 bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-foreground"
      >
        {terminal ? (
          <>
            <SheetHeader className="pr-8">
              <SheetTitle className="text-base text-foreground">
                {mode === "handoff" ? "发给 Hermes" : terminal.statusLabel}
              </SheetTitle>
              <SheetDescription className="truncate text-xs">
                {terminal.projectName} · {terminal.shortId}
              </SheetDescription>
            </SheetHeader>

            {mode === "handoff" ? (
              <HermesHandoffPreview
                terminal={terminal}
                copied={copied}
                copyError={copyError}
                onCopy={onCopy}
                onCopyAndPromptFeishu={onCopyAndPromptFeishu}
              />
            ) : (
              <div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">
                    判断依据
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-foreground/80">
                    {terminal.stateReason.map((reason) => (
                      <li key={reason}>- {reason}</li>
                    ))}
                  </ul>
                </div>

                <div className="mt-4">
                  <p className="text-xs font-semibold text-muted-foreground">
                    最近输出
                  </p>
                  <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-900/10 bg-slate-950 p-3 font-mono text-[11px] leading-4 text-slate-100 dark:border-white/10 dark:bg-black/40">
                    {terminal.tailPreview || "暂无 tail"}
                  </pre>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                    onClick={() => {
                      onModeChange("handoff");
                    }}
                  >
                    <Send className="h-4 w-4" />
                    发给 Hermes
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-card/70 px-3 text-xs font-semibold text-foreground transition-colors hover:border-border"
                    onClick={() => {
                      onModeChange("handoff");
                    }}
                  >
                    <MessageSquare className="h-4 w-4" />
                    总结终端
                  </button>
                  <button
                    type="button"
                    className="col-span-2 inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-card/70 px-3 text-xs font-semibold text-foreground transition-colors hover:border-border"
                    onClick={() => {
                      onOpenFullTerminal(terminal.terminalSessionId);
                    }}
                  >
                    <ExternalLink className="h-4 w-4" />
                    打开终端
                  </button>
                </div>
              </div>
            )}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
