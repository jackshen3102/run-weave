import { RecordBody, SuijiAttachmentView, recordDate } from "./record-content";
export { RecordBody, SuijiAttachmentView, recordDate } from "./record-content";
import { suijiHandoff, type SuijiInfo } from "@runweave/shared/suiji";
import { SuijiFollowups } from "./followups";
import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { Copy } from "lucide-react";
import type { SuijiRecord } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import { SuijiPanel } from "./panel";
import type { SuijiClient } from "../../services/suiji";
import { RecordTags } from "./tags";

export const statusText = (record: Pick<SuijiRecord, "kind" | "taskStatus">) =>
  record.kind === "note"
    ? "想法"
    : { open: "未完成", done: "已完成", archived: "不再做" }[
        record.taskStatus ?? "open"
      ];
export function SuijiRecordDetail({
  record,
  onOpenLink,
  client,
  onTag,
  onClose,
  onEdit,
  onStatus,
  onTrash,
  onReview,
  onRecreate,
  info, onFollowup, onRecord,
  writable,
  pending,
  busy,
  citedVersion,
}: {
  record: SuijiRecord;
  onOpenLink?: (url: string) => void;
  client: SuijiClient;
  onTag: (tag: string) => void;
  onClose: () => void;
  onEdit: () => void;
  onStatus: (status: "open" | "done" | "archived") => void;
  onTrash: (trashed: boolean) => void;
  onReview: () => void;
  onRecreate: () => void;
  info: SuijiInfo; onFollowup: () => void; onRecord: (record: SuijiRecord) => void;
  writable: boolean;
  pending: boolean;
  busy: boolean;
  citedVersion?: number;
}) {
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  useEffect(() => {
    setCopyFeedback("");
  }, [record.id, record.body]);
  useEffect(() => {
    if (!copyFeedback) return;
    const timer = window.setTimeout(() => setCopyFeedback(""), 2500);
    return () => window.clearTimeout(timer);
  }, [copyFeedback]);
  const copyBody = useMemoizedFn(async () => {
    setCopying(true);
    setCopyFeedback("");
    try {
      await navigator.clipboard.writeText(record.body);
      setCopyFeedback(
        record.attachments.length ? "正文已复制，附件未包含" : "正文已复制",
      );
    } catch {
      setCopyFeedback("复制失败，请重试或选择正文手动复制");
    } finally {
      setCopying(false);
    }
  });
  return (
    <SuijiPanel
      title={statusText(record)}
      description={recordDate(record.createdAt)}
      onBack={onClose}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="复制"
            title={record.body ? "复制" : "暂无正文可复制"}
            disabled={!record.body || copying}
            onClick={() => void copyBody()}
          >
            <Copy className="size-4" />
          </Button>
          <Button
            variant="ghost"
            disabled={!writable || pending || busy || Boolean(record.deletedAt)}
            onClick={onEdit}
          >
            编辑
          </Button>
        </>
      }
      feedback={
        copyFeedback ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-5 z-10 flex justify-center">
            <p
              role="status"
              className="rounded-full border bg-popover px-4 py-2.5 text-center text-sm text-popover-foreground shadow-lg"
            >
              {copyFeedback}
            </p>
          </div>
        ) : null
      }
    >
      {citedVersion !== undefined && citedVersion !== record.version ? (
        <p role="status" className="text-sm text-muted-foreground">
          此记录已更新；回答引用的是版本 {citedVersion}，下方是当前原文。
        </p>
      ) : null}
      <RecordBody body={record.body} onOpenLink={onOpenLink} />
      <RecordTags tags={record.tags} onSelect={onTag} />
      <div className="flex flex-wrap gap-2">
        {record.attachments.map((a) => (
          <SuijiAttachmentView key={a.id} attachment={a} client={client} />
        ))}
      </div>
      {info.features?.followups ? <>
        {!record.deletedAt ? <Button variant="outline" onClick={() => {
          void navigator.clipboard.writeText(suijiHandoff({ endpoint: client.endpoint, serverId: info.serverId, ownerId: info.ownerId, recordId: record.id })).then(() => setCopyFeedback("交接指令已复制"), () => setCopyFeedback("复制失败，请重试"));
        }}>交给 Agent</Button> : null}
        <SuijiFollowups record={record} client={client} writable={writable} onAdd={onFollowup} onRecord={onRecord} onOpenLink={onOpenLink} />
      </> : null}
      {record.deletedAt ? (
        <p role="status">已在回收站，恢复后可继续编辑。</p>
      ) : null}
      {pending ? (
        <Button disabled={!writable || busy} onClick={() => onStatus("done")}>
          操作结果待确认 · 手动确认
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={Boolean(record.deletedAt)}
          onClick={onReview}
        >
          聊聊这条
        </Button>
        {!record.deletedAt &&
        record.kind === "task" &&
        (record.taskStatus === "open" || pending) ? (
          <>
            <Button
              disabled={!writable || busy}
              onClick={() => onStatus("done")}
            >
              {pending ? "手动确认状态" : "标记完成"}
            </Button>
            {!pending ? (
              <Button
                variant="outline"
                disabled={!writable || busy}
                onClick={() => onStatus("archived")}
              >
                不再做
              </Button>
            ) : null}
          </>
        ) : !record.deletedAt && record.taskStatus === "done" ? (
          <Button
            disabled={!writable || busy || pending}
            onClick={() => onStatus("open")}
          >
            撤销完成
          </Button>
        ) : !record.deletedAt && record.kind === "task" ? (
          <Button disabled={!writable} onClick={onRecreate}>
            再次想做
          </Button>
        ) : null}
        {record.deletedAt ? (
          <Button
            disabled={!writable || pending || busy}
            onClick={() => onTrash(false)}
          >
            恢复记录
          </Button>
        ) : confirmTrash ? (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span>移入回收站后可恢复，正文和附件会保留。</span>
            <Button
              variant="destructive"
              disabled={!writable || pending || busy}
              onClick={() => {
                setConfirmTrash(false);
                onTrash(true);
              }}
            >
              确认移入回收站
            </Button>
            <Button variant="ghost" onClick={() => setConfirmTrash(false)}>
              取消
            </Button>
          </div>
        ) : (
          <Button
            variant="destructive"
            disabled={!writable || pending || busy}
            onClick={() => setConfirmTrash(true)}
          >
            移入回收站
          </Button>
        )}
      </div>
    </SuijiPanel>
  );
}

export function SuijiRecordCard({
  record,
  pending,
  onOpen,
  onOpenLink,
  onTag,
}: {
  record: SuijiRecord;
  pending: boolean;
  onOpen: () => void;
  onOpenLink?: (url: string) => void;
  onTag: (tag: string) => void;
}) {
  return (
    <article className="relative flex flex-col gap-3 rounded-2xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-accent">
      <button
        type="button"
        aria-label={`查看记录：${record.body || "附件记录"}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="pointer-events-none relative flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {statusText(record)}
          {pending ? " · 状态待确认" : ""}
        </span>
        <time>{recordDate(record.createdAt)}</time>
      </span>
      <RecordBody
        onOpenLink={onOpenLink}
        body={record.body || "附件记录"}
        className="pointer-events-none relative line-clamp-5"
      />
      {record.attachments.length ? (
        <span className="pointer-events-none relative text-xs text-muted-foreground">
          {record.attachments.map((a) => a.fileName).join(" · ")}
        </span>
      ) : null}
      {record.followupSummary?.latest ? <p className="pointer-events-none relative truncate text-sm text-muted-foreground">跟进 {record.followupSummary.count} 条 · {record.followupSummary.latest.excerpt}</p> : null}
      <RecordTags tags={record.tags} onSelect={onTag} />
    </article>
  );
}
