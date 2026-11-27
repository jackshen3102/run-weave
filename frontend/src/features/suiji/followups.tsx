import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  FollowupPage,
  RecordResponse,
  SuijiFollowup,
  SuijiRecord,
} from "@runweave/shared/suiji";
import type { SuijiClient } from "../../services/suiji";
import { Button } from "../../components/ui/button";
import { RecordBody, SuijiAttachmentView, recordDate } from "./record-content";

export function SuijiFollowups({
  record,
  client,
  writable,
  onAdd,
  onRecord,
  onOpenLink,
}: {
  record: SuijiRecord;
  client: SuijiClient;
  writable: boolean;
  onAdd: () => void;
  onRecord: (record: SuijiRecord) => void;
  onOpenLink?: (url: string) => void;
}) {
  const [items, setItems] = useState<SuijiFollowup[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const match = record.followupMatch;
  const matchedArticle = useRef<HTMLElement>(null);
  const matchedId = showLatest ? undefined : match?.id;
  const firstId = items[0]?.id;
  useEffect(() => {
    if (!matchedId || firstId !== matchedId) return;
    matchedArticle.current?.focus({ preventScroll: true });
    matchedArticle.current?.scrollIntoView({ block: "start" });
  }, [firstId, matchedId]);
  const load = useMemoizedFn(async (more = false, latest = showLatest) => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const base = `/api/suiji/v1/records/${record.id}`;
      const start = more ? cursor : latest ? undefined : match?.cursor;
      const [page, current] = await Promise.all([
        client.request<FollowupPage>(
          base +
            "/followups" +
            (start ? "?cursor=" + encodeURIComponent(start) : ""),
        ),
        more ? undefined : client.request<RecordResponse>(base),
      ]);
      if (!client.active || request !== generation.current) return;
      setItems((old) =>
        more
          ? [
              ...old,
              ...page.items.filter(
                (item) => !old.some((value) => value.id === item.id),
              ),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
      if (!more) setShowLatest(latest);
      if (current) onRecord(current.record);
    } catch (reason) {
      if (request === generation.current)
        setError(reason instanceof Error ? reason.message : "跟进读取失败");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  });
  useEffect(() => {
    const counter = generation;
    void load();
    return () => {
      ++counter.current;
    };
  }, [load, record.id, client]);
  return (
    <section className="flex flex-col gap-4 border-t pt-4" aria-label="跟进">
      <div className="flex items-center justify-between gap-2">
        <h3>跟进 {record.followupSummary?.count ?? items.length} 条</h3>
        <Button variant="ghost" disabled={busy} onClick={() => void load(false, Boolean(matchedId) || showLatest)}>
          {matchedId ? "查看最新跟进" : "刷新跟进"}
        </Button>
        {matchedId && error ? <Button variant="ghost" disabled={busy} onClick={() => void load()}>重试定位</Button> : null}
        {!record.deletedAt ? (
          <Button disabled={!writable} onClick={onAdd}>
            追加跟进
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {items.map((item) => (
        <article
          key={item.id}
          ref={item.id === matchedId ? matchedArticle : undefined}
          tabIndex={item.id === matchedId ? -1 : undefined}
          className={`flex scroll-mt-16 flex-col gap-2 rounded-xl border p-4${item.id === matchedId ? " border-primary" : ""}`}
        >
          {item.id === matchedId ? <p className="text-xs font-medium text-primary">命中的跟进</p> : null}
          <p className="text-xs text-muted-foreground">
            {item.source.actor === "app"
              ? "你"
              : `Agent${item.source.agentName ? " · " + item.source.agentName : ""}`}{" "}
            · {recordDate(item.createdAt)}
          </p>
          {item.source.sessionId ? (
            <p className="break-all text-xs text-muted-foreground">
              会话：{item.source.sessionId}
            </p>
          ) : null}
          <RecordBody body={item.body} onOpenLink={onOpenLink} />
          {item.attachments.map((file) => (
            <SuijiAttachmentView
              key={file.id}
              attachment={file}
              client={client}
            />
          ))}
        </article>
      ))}
      {busy ? <p role="status">正在读取跟进…</p> : null}
      {cursor ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load(true)}
        >
          加载更早跟进
        </Button>
      ) : null}
    </section>
  );
}
