import type { SessionListItem as SessionListItemType } from "@browser-viewer/shared";
import { MoreHorizontal } from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
  getHeaderSummaryLabel,
  getProxyStatusLabel,
  getSessionSourceLabel,
} from "../utils";

interface SessionListItemProps {
  session: SessionListItemType;
  isDeleting: boolean;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onRename: () => void;
  onRemove: () => void;
  onResume: () => void;
}

export function SessionListItem({
  session,
  isDeleting,
  isMenuOpen,
  onToggleMenu,
  onRename,
  onRemove,
  onResume,
}: SessionListItemProps) {
  return (
    <article className="rounded-[1.5rem] border border-border/60 bg-card/72 p-4 transition-colors hover:border-border/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                session.connected ? "bg-emerald-500" : "bg-stone-400"
              }`}
            />
            <span className="text-xs text-muted-foreground">
              {session.connected ? "Live" : "Idle"}
            </span>
          </div>
          <p className="text-xl font-semibold tracking-[-0.04em] text-foreground">
            {session.name}
          </p>
          <p className="text-sm text-muted-foreground/80">
            {getSessionSourceLabel(session.sourceType)}
            {" \u00b7 "}
            {getProxyStatusLabel(session.proxyEnabled)}
            {" \u00b7 "}
            {getHeaderSummaryLabel(session.headers)}
          </p>
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
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition hover:bg-muted/60"
                onClick={onRename}
              >
                <span>Rename session</span>
              </button>
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
          Open
        </Button>
      </div>
    </article>
  );
}
