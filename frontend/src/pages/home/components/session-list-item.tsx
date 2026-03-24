import type { SessionListItem as SessionListItemType } from "@browser-viewer/shared";
import { MoreHorizontal } from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
  formatDateTime,
  getHeaderSummaryLabel,
  getProxyStatusLabel,
  getSessionDisplayTitle,
  getSessionSourceLabel,
} from "../utils";

interface SessionListItemProps {
  session: SessionListItemType;
  isDeleting: boolean;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onRemove: () => void;
  onResume: () => void;
}

export function SessionListItem({
  session,
  isDeleting,
  isMenuOpen,
  onToggleMenu,
  onRemove,
  onResume,
}: SessionListItemProps) {
  return (
    <article className="rounded-[1.5rem] border border-border/60 bg-card/72 p-4 transition-colors hover:border-border/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                session.connected ? "bg-emerald-500" : "bg-stone-400"
              }`}
            />
            <p className="truncate text-base font-medium tracking-[-0.03em] text-foreground">
              {getSessionDisplayTitle(session.targetUrl)}
            </p>
          </div>
          <p className="truncate text-sm text-muted-foreground">{session.targetUrl}</p>
          <p className="text-xs text-muted-foreground/85">
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
          {Object.keys(session.headers).length > 0 && (
            <div className="space-y-1 rounded-2xl border border-border/50 bg-background/45 px-3 py-2 text-xs text-muted-foreground">
              {Object.entries(session.headers).map(([key, value]) => (
                <p key={key} className="break-all">
                  <span className="font-medium text-foreground">{key}</span>
                  {": "}
                  {value}
                </p>
              ))}
            </div>
          )}
        </div>
        <div
          className="relative flex items-center gap-2"
          data-session-menu-root="true"
        >
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-3 text-muted-foreground"
            aria-label="Session actions"
            onClick={onToggleMenu}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {isMenuOpen && (
            <div className="animate-scale-fade absolute right-0 top-11 z-10 min-w-40 rounded-2xl border border-border/70 bg-background/96 p-2 shadow-[0_20px_50px_-30px_rgba(17,24,39,0.55)] backdrop-blur-xl">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-red-500 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                disabled={isDeleting}
                onClick={onRemove}
              >
                <span>{isDeleting ? "Removing..." : "Remove session"}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
        <Button size="sm" className="rounded-full px-4" onClick={onResume}>
          Resume
        </Button>
      </div>
    </article>
  );
}
