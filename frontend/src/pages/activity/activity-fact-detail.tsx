import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import { X } from "lucide-react";
import type { ActivityFactDto } from "@runweave/shared/activity";
import { Button } from "../../components/ui/button";
import { fetchActivityContent } from "../../services/activity";

export function ActivityFactDetail({
  apiBase,
  token,
  fact,
  onClose,
}: {
  apiBase: string;
  token: string;
  fact: ActivityFactDto;
  onClose: () => void;
}) {
  const [contentId, setContentId] = useState<string | null>(null);
  const contentQuery = useQuery({
    queryKey: ["activity", "content", apiBase, contentId],
    queryFn: () => fetchActivityContent(apiBase, token, contentId as string),
    enabled: Boolean(contentId),
  });
  const selectContent = useMemoizedFn((nextContentId: string) => {
    setContentId(nextContentId);
  });
  const decodedContent = contentQuery.data?.bytesBase64
    ? new TextDecoder().decode(
        Uint8Array.from(atob(contentQuery.data.bytesBase64), (character) =>
          character.charCodeAt(0),
        ),
      )
    : null;

  return (
    <aside className="mt-4 rounded-xl border border-border/70 bg-card/70 p-5" aria-label="Fact detail">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="rounded-full border border-border px-2 py-1 text-[0.68rem] text-muted-foreground">
            Recorded
          </span>
          <h2 className="mt-3 font-semibold">{fact.eventName}</h2>
          <p className="mt-1 break-all text-xs text-muted-foreground">{fact.eventId}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close fact detail">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Recorded at</dt><dd>{fact.occurredAt}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Ingest offset</dt><dd>{fact.activityOffset}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Runtime</dt><dd>{fact.runtime.channel} · {fact.runtime.surface}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Result</dt><dd>{fact.result?.status ?? "not reported"}</dd></div>
      </dl>
      <div className="mt-5">
        <p className="text-xs font-medium text-muted-foreground">Recorded payload</p>
        <pre className="mt-2 overflow-auto rounded-lg bg-muted/50 p-3 text-xs">{JSON.stringify(fact.payload, null, 2)}</pre>
      </div>
      <div className="mt-5">
        <p className="text-xs font-medium text-muted-foreground">Short-lived content</p>
        {fact.contentDescriptors.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No Content descriptor was recorded.</p>
        ) : (
          <div className="mt-2 grid gap-2">
            {fact.contentDescriptors.map((descriptor) => (
              <div key={descriptor.contentId} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3 text-sm">
                <div>
                  <p>{descriptor.role} · {descriptor.mediaType}</p>
                  <p className="text-xs text-muted-foreground">{descriptor.availability} · {descriptor.byteLength} bytes</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={descriptor.availability !== "available"}
                  onClick={() => selectContent(descriptor.contentId)}
                >
                  Read content
                </Button>
              </div>
            ))}
          </div>
        )}
        {contentId ? (
          <div className="mt-3 rounded-lg border border-border/70 p-3">
            {contentQuery.isPending ? <p className="text-sm text-muted-foreground">Reading audited content…</p> : null}
            {contentQuery.isError ? <p className="text-sm text-destructive">Content is unavailable or expired.</p> : null}
            {decodedContent !== null ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{decodedContent}</pre> : null}
          </div>
        ) : null}
      </div>
      <div className="mt-5">
        <p className="text-xs font-medium text-muted-foreground">External references</p>
        {fact.externalRefDescriptors.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No ExternalRef descriptor was recorded.
          </p>
        ) : (
          <div className="mt-2 grid gap-2">
            {fact.externalRefDescriptors.map((descriptor) => (
              <div
                key={descriptor.refId}
                className="rounded-lg border border-border/70 p-3 text-sm"
              >
                <p>{descriptor.role} · {descriptor.authority}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {descriptor.availability} · {descriptor.versionOrDigest}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
