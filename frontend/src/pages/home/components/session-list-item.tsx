import type { SessionListItem as SessionListItemType } from "@browser-viewer/shared";
import { Button } from "../../../components/ui/button";
import {
  getHeaderSummaryLabel,
  getProxyStatusLabel,
  getSessionSourceLabel,
} from "../utils";

interface SessionListItemProps {
  session: SessionListItemType;
  isDeleting: boolean;
  isUpdatingAiPreference: boolean;
  actions?: "full" | "open-only";
  onRename: () => void;
  onRemove: () => void;
  onResume: () => void;
  onToggleAiPreference: () => void;
}

export function SessionListItem({
  session,
  isDeleting,
  isUpdatingAiPreference,
  actions = "full",
  onRename,
  onRemove,
  onResume,
  onToggleAiPreference,
}: SessionListItemProps) {
  const canSetAiDefault = session.sourceType === "launch";

  return (
    <article className="rounded-[1.25rem] border border-border/60 bg-card/72 p-4 transition-colors hover:border-border/80">
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              session.connected ? "bg-emerald-500" : "bg-stone-400"
            }`}
          />
          <span className="text-xs text-muted-foreground">
            {session.connected ? "Live" : "Idle"}
          </span>
          {session.preferredForAi ? (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              Default AI Viewer
            </span>
          ) : null}
        </div>

        <p className="text-lg font-semibold tracking-[-0.04em] text-foreground">
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

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" className="rounded-full px-4" onClick={onResume}>
          Open
        </Button>
        {actions === "full" && canSetAiDefault ? (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full px-4"
            disabled={isUpdatingAiPreference}
            onClick={onToggleAiPreference}
          >
            {isUpdatingAiPreference
              ? "Saving..."
              : session.preferredForAi
                ? "Unset Default AI Viewer"
                : "Set Default AI Viewer"}
          </Button>
        ) : null}
        {actions === "full" ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-4"
              onClick={onRename}
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-4 text-red-500 hover:text-red-600"
              disabled={isDeleting}
              onClick={onRemove}
            >
              {isDeleting ? "Removing..." : "Remove"}
            </Button>
          </>
        ) : null}
      </div>
    </article>
  );
}
