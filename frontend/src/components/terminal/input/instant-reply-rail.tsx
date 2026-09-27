import { ChevronRight, CornerDownLeft, MessageSquareReply } from "lucide-react";

const INSTANT_REPLIES = [
  { id: "accept", text: "可以" },
  { id: "continue", text: "继续" },
  { id: "decline", text: "不需要" },
] as const;

export type TerminalInstantReply = (typeof INSTANT_REPLIES)[number]["text"];

export interface TerminalInstantReplyFeedback {
  message: string;
  tone: "error" | "success";
}

interface TerminalInstantReplyRailProps {
  available: boolean;
  feedback: TerminalInstantReplyFeedback | null;
  open: boolean;
  sending: boolean;
  onClose: () => void;
  onOpen: () => void;
  onSend: (reply: TerminalInstantReply) => void;
}

export function TerminalInstantReplyRail({
  available,
  feedback,
  open,
  sending,
  onClose,
  onOpen,
  onSend,
}: TerminalInstantReplyRailProps) {
  if (!available) {
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded="false"
        aria-label="展开一键回复"
        title="展开一键回复"
        className="pointer-events-auto absolute top-1/2 right-0 flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-slate-700/90 bg-[#07111f]/95 px-2 py-2.5 text-[11px] font-medium text-slate-300 shadow-2xl shadow-slate-950/45 backdrop-blur transition hover:border-cyan-400/45 hover:bg-slate-900 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        data-testid="terminal-instant-reply-trigger"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onOpen}
      >
        <MessageSquareReply
          aria-hidden="true"
          className="h-4 w-4 text-cyan-300"
        />
        <span className="[writing-mode:vertical-rl]">一键回复</span>
      </button>
    );
  }

  return (
    <aside
      aria-label="一键回复"
      className="pointer-events-auto absolute top-1/2 right-0 w-[218px] -translate-y-1/2 rounded-l-xl border border-r-0 border-slate-700/90 bg-[#07111f]/95 p-2.5 shadow-[-18px_18px_55px_rgba(0,0,0,0.42)] backdrop-blur"
      data-testid="terminal-instant-reply-rail"
    >
      <div className="flex h-7 items-center justify-between px-1 pb-1.5 text-[11px] font-semibold text-slate-300">
        <span>一键回复</span>
        <button
          type="button"
          aria-expanded="true"
          aria-label="收起一键回复"
          title="收起一键回复"
          className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:text-slate-600"
          disabled={sending}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid gap-1.5">
        {INSTANT_REPLIES.map(({ id, text }) => (
          <button
            key={id}
            type="button"
            aria-label={`发送“${text}”`}
            className="flex h-10 items-center justify-between rounded-lg border border-slate-700/90 bg-slate-900/80 px-3 text-xs text-slate-200 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 active:bg-cyan-400/15 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900/50 disabled:text-slate-500"
            data-testid={`terminal-instant-reply-${id}`}
            disabled={sending}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onSend(text)}
          >
            <span>{text}</span>
            <CornerDownLeft
              aria-hidden="true"
              className="h-3.5 w-3.5 text-cyan-400"
            />
          </button>
        ))}
      </div>
      {sending ? (
        <p role="status" className="mt-2 px-1 text-[11px] text-slate-400">
          正在发送…
        </p>
      ) : feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={
            feedback.tone === "error"
              ? "mt-2 px-1 text-[11px] leading-4 text-amber-300"
              : "mt-2 px-1 text-[11px] leading-4 text-emerald-300"
          }
        >
          {feedback.message}
        </p>
      ) : null}
    </aside>
  );
}
