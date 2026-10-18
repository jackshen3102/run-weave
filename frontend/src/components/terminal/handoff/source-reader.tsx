import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  FollowupPage,
  SuijiFollowup,
  SuijiRecord,
} from "@runweave/shared/suiji";
import { Button } from "../../ui/button";
import {
  RecordBody,
  SuijiAttachmentView,
  recordDate,
} from "../../../features/suiji/record-content";
import { useSuijiConnection } from "../../../features/suiji/connection-provider";

export function HandoffSourceReader({
  record,
  back,
}: {
  record: SuijiRecord;
  back: () => void;
}) {
  const { connection, isCurrent, editAccount } = useSuijiConnection();
  const [page, setPage] = useState<{
    items: SuijiFollowup[];
    cursor: string | null;
  }>({ items: [], cursor: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const client = connection?.client;
  const load = useMemoizedFn(async (more = false) => {
    if (!client) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const result = await client.request<FollowupPage>(
        `/api/suiji/v1/records/${encodeURIComponent(record.id)}/followups${more && page.cursor ? `?cursor=${encodeURIComponent(page.cursor)}` : ""}`,
      );
      if (ticket !== sequence.current || !isCurrent(client)) return;
      setPage((old) => ({
        items: more
          ? [
              ...old.items,
              ...result.items.filter(
                (item) =>
                  !old.items.some((existing) => existing.id === item.id),
              ),
            ]
          : result.items,
        cursor: result.nextCursor,
      }));
    } catch (cause) {
      if (
        ticket === sequence.current &&
        cause &&
        typeof cause === "object" &&
        "status" in cause &&
        cause.status === 401
      )
        editAccount();
      if (ticket === sequence.current)
        setError(cause instanceof Error ? cause.message : "跟进读取失败");
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  });
  useEffect(() => {
    const counter = sequence;
    void load();
    return () => {
      ++counter.current;
    };
  }, [record.id, client, load]);
  if (!client || !client.active)
    return (
      <p className="text-xs text-muted-foreground">请先登录原随记账号。</p>
    );
  return (
    <section
      className="suiji-theme flex min-w-0 flex-col gap-5 text-foreground"
      aria-label="关联随记原文"
    >
      <Button variant="ghost" size="sm" onClick={back} className="self-start">
        返回任务交接
      </Button>
      <div className="flex items-center justify-between gap-2">
        <h3>随记原文</h3>
        <span className="text-xs text-muted-foreground">
          {record.kind === "task"
            ? { open: "未完成", done: "已完成", archived: "不再做" }[
                record.taskStatus ?? "open"
              ]
            : "想法"}
        </span>
      </div>
      <RecordBody body={record.body} />
      {record.attachments.map((item) => (
        <SuijiAttachmentView key={item.id} attachment={item} client={client} />
      ))}
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <h3>跟进</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void load()}
        >
          刷新跟进
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {page.items.map((item) => (
        <article key={item.id} className="flex flex-col gap-3 border-l-2 pl-3">
          <div className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {item.source.actor === "app"
                ? "你"
                : item.source.agentName || "Agent"}
            </span>
            <span>{recordDate(item.createdAt)}</span>
          </div>
          <RecordBody body={item.body} />
          {item.attachments.map((file) => (
            <SuijiAttachmentView
              key={file.id}
              attachment={file}
              client={client}
            />
          ))}
        </article>
      ))}
      {page.cursor ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? "读取中…" : "加载更多跟进"}
        </Button>
      ) : null}
      {!page.items.length && !busy && !error ? (
        <p className="text-xs text-muted-foreground">暂无跟进。</p>
      ) : null}
    </section>
  );
}
