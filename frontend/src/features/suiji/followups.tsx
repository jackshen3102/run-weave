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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const load = useMemoizedFn(async (more = false) => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const base = `/api/suiji/v1/records/${record.id}`;
      const [page, current] = await Promise.all([
        client.request<FollowupPage>(
          base +
            "/followups" +
            (more && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
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
        <Button variant="ghost" disabled={busy} onClick={() => void load()}>
          刷新跟进
        </Button>
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
          className="flex flex-col gap-2 rounded-xl border p-4"
        >
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
