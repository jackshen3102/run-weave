import { useEffect, useRef, useState } from "react";
import { useDebounce, useMemoizedFn } from "ahooks";
import type {
  RecordPage,
  RecordResponse,
  SuijiRecord,
} from "@runweave/shared/suiji";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { RecordBody } from "../../../features/suiji/record-content";
import { useSuijiConnection } from "../../../features/suiji/connection-provider";
import { HandoffSourceReader } from "./source-reader";

export const recordFingerprint = (record: SuijiRecord) =>
  JSON.stringify([
    record.version,
    record.followupSummary?.latest?.sequence ?? 0,
    record.deletedAt ?? null,
  ]);
export function SuijiLinkDialog({
  open,
  close,
  confirm,
}: {
  open: boolean;
  close: () => void;
  confirm: (record: SuijiRecord) => Promise<void>;
}) {
  const { connection, isCurrent, editAccount } = useSuijiConnection();
  const client = connection?.client;
  const [query, setQuery] = useState("");
  const search = useDebounce(query, { wait: 250 });
  const [items, setItems] = useState<SuijiRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<SuijiRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [readAll, setReadAll] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const load = useMemoizedFn(async (more = false) => {
    if (!client) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (more && cursor) params.set("cursor", cursor);
      const response = await client.request<RecordPage>(
        `/api/suiji/v1/records?${params}`,
      );
      if (ticket !== sequence.current || !isCurrent(client) || !mounted.current)
        return;
      setItems((old) =>
        more
          ? [
              ...old,
              ...response.items.filter(
                (item) => !old.some((existing) => existing.id === item.id),
              ),
            ]
          : response.items,
      );
      setCursor(response.nextCursor);
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "status" in cause &&
        cause.status === 401
      )
        editAccount();
      if (ticket === sequence.current && mounted.current)
        setError(cause instanceof Error ? cause.message : "读取随记失败");
    } finally {
      if (ticket === sequence.current && mounted.current) setBusy(false);
    }
  });
  useEffect(() => {
    const counter = sequence;
    mounted.current = true;
    if (open) {
      setSelected(null);
      setChanged(false);
      setReadAll(false);
      void load();
    }
    return () => {
      ++counter.current;
      mounted.current = false;
    };
  }, [open, client, search, load]);
  const select = useMemoizedFn(async (record: SuijiRecord) => {
    if (!client || busy) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError("");
    setChanged(false);
    setSelected(null);
    setReadAll(false);
    try {
      const response = await client.request<RecordResponse>(
        `/api/suiji/v1/records/${encodeURIComponent(record.id)}`,
      );
      if (ticket === sequence.current && mounted.current && isCurrent(client))
        setSelected(response.record);
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "status" in cause &&
        cause.status === 401
      )
        editAccount();
      if (ticket === sequence.current && mounted.current)
        setError(cause instanceof Error ? cause.message : "原文读取失败");
    } finally {
      if (ticket === sequence.current && mounted.current) setBusy(false);
    }
  });
  const save = useMemoizedFn(async () => {
    if (!client || !selected || busy) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const response = await client.request<RecordResponse>(
        `/api/suiji/v1/records/${encodeURIComponent(selected.id)}`,
      );
      if (!mounted.current || ticket !== sequence.current || !isCurrent(client))
        return;
      if (response.record.deletedAt)
        throw new Error("这条随记已删除，请重新选择");
      if (recordFingerprint(response.record) !== recordFingerprint(selected)) {
        setChanged(true);
        setSelected(response.record);
        return;
      }
      await confirm(response.record);
      if (mounted.current && ticket === sequence.current && isCurrent(client))
        close();
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "status" in cause &&
        cause.status === 401
      )
        editAccount();
      if (mounted.current && ticket === sequence.current)
        setError(cause instanceof Error ? cause.message : "关联失败");
    } finally {
      if (mounted.current && ticket === sequence.current) setBusy(false);
    }
  });
  return (
    <Dialog
      open={open && !!client?.active}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="suiji-theme flex max-h-[85vh] flex-col overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>关联随记</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-1">
          <Input
            aria-label="搜索随记"
            placeholder="搜索随记内容…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            {items.map((record) => (
              <Button
                key={record.id}
                variant={selected?.id === record.id ? "secondary" : "ghost"}
                className="h-auto justify-start whitespace-normal py-3 text-left"
                disabled={busy}
                onClick={() => void select(record)}
              >
                <span className="line-clamp-2 break-words">{record.body}</span>
              </Button>
            ))}
          </div>
          {cursor ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void load(true)}
            >
              加载更多随记
            </Button>
          ) : null}
          {!busy && !items.length ? (
            <p className="text-xs text-muted-foreground">
              没有找到匹配的随记。
            </p>
          ) : null}
          {selected && readAll ? (
            <HandoffSourceReader record={selected} back={() => setReadAll(false)} />
          ) : selected ? (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <h3 className="text-xs text-muted-foreground">原文</h3>
              <p className="text-xs text-muted-foreground">
                {selected.kind === "task" ? { open: "未完成", done: "已完成", archived: "不再做" }[selected.taskStatus ?? "open"] : "想法"}
              </p>
              <RecordBody body={selected.body} />
              {selected.followupSummary?.latest ? (
                <>
                  <h3 className="text-xs text-muted-foreground">
                    最新跟进 ·{" "}
                    {selected.followupSummary.latest.source.actor === "app"
                      ? "你"
                      : "Agent"}
                  </h3>
                  <p className="whitespace-pre-wrap break-words text-xs">
                    {selected.followupSummary.latest.excerpt}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    关联后可打开原文并逐页阅读全部跟进。
                  </p>
                </>
              ) : null}
              <Button variant="link" size="sm" onClick={() => setReadAll(true)}>查看原文与全部跟进</Button>
            </div>
          ) : null}
          {changed ? (
            <p role="alert" className="text-xs text-destructive">
              这条随记有新的内容，已重新读取。请核对上方原文和补充后再次确认。
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button disabled={!selected || busy} onClick={() => void save()}>
            {busy ? "读取中…" : changed ? "确认关联最新内容" : "关联到当前会话"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
