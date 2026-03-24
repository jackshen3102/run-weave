import type { SessionListItem } from "@browser-viewer/shared";
import { Button } from "../../../components/ui/button";
import {
  formatDateTime,
  getHeaderSummaryLabel,
  getProxyStatusLabel,
  getSessionDisplayTitle,
  getSessionSourceLabel,
} from "../utils";

interface LatestSessionCardProps {
  session: SessionListItem | null;
  onEnterSession: (sessionId: string) => void;
}

export function LatestSessionCard({
  session,
  onEnterSession,
}: LatestSessionCardProps) {
  return (
    <section
      className={`animate-fade-rise rounded-[2rem] border border-border/60 bg-card/75 p-6 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl transition hover:border-border/80 sm:p-8 ${
        session ? "cursor-pointer" : ""
      }`}
      role={session ? "button" : undefined}
      tabIndex={session ? 0 : undefined}
      onClick={session ? () => onEnterSession(session.sessionId) : undefined}
      onKeyDown={
        session
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onEnterSession(session.sessionId);
              }
            }
          : undefined
      }
    >
      {session ? (
        <>
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground/70">
              Latest Session
            </p>
            <span className="inline-flex items-center gap-2 rounded-full bg-background/70 px-3 py-1 text-xs text-muted-foreground">
              <span
                className={`h-2 w-2 rounded-full ${
                  session.connected ? "bg-emerald-500" : "bg-stone-400"
                }`}
              />
              {session.connected ? "Live" : "Idle"}
            </span>
          </div>

          <div className="mt-12 space-y-4">
            <p className="text-4xl font-semibold tracking-[-0.06em] text-foreground sm:text-[4.2rem] sm:leading-[0.96]">
              {getSessionDisplayTitle(session.targetUrl)}
            </p>
            <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
              {session.targetUrl}
            </p>
            <p className="text-sm text-muted-foreground/85">
              Last active {formatDateTime(session.lastActivityAt)}
            </p>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">
              {getProxyStatusLabel(session.proxyEnabled)}
            </p>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">
              {getSessionSourceLabel(session.sourceType)}
            </p>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">
              {getHeaderSummaryLabel(session.headers)}
            </p>
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-3">
            <Button
              className="h-11 rounded-full px-6 text-sm"
              onClick={(event) => {
                event.stopPropagation();
                onEnterSession(session.sessionId);
              }}
            >
              Resume
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-12 py-8 sm:py-14">
          <div className="space-y-4">
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground/70">
              Start
            </p>
            <p className="max-w-xl text-4xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl">
              Nothing open yet. Start with a page.
            </p>
          </div>
          <p className="max-w-lg text-sm leading-6 text-muted-foreground sm:text-base">
            Open one address and let the stage stay quiet around it.
          </p>
        </div>
      )}
    </section>
  );
}
