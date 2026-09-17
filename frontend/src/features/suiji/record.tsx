import { useEffect, useMemo, useState, type ReactNode } from "react";
import LinkifyIt from "linkify-it";
import type { SuijiAttachment, SuijiRecord } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import { SuijiPanel } from "./panel";
import type { SuijiClient } from "../../services/suiji";

export const statusText = (record: Pick<SuijiRecord, "kind" | "taskStatus">) =>
  record.kind === "note"
    ? "想法"
    : { open: "未完成", done: "已完成", archived: "不再做" }[
        record.taskStatus ?? "open"
      ];
export const recordDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: false });
linkify.onCompile = function () {
  // linkify-it exposes these regex source strings through onCompile; its typings
  // incorrectly declare all re entries as RegExp. Treat CJK prose punctuation as boundaries.
  const keys = ["src_path", "tpl_link_fuzzy", "tpl_link_no_ip_fuzzy"] as const;
  const patterns = this.re as unknown as Record<
    (typeof keys)[number] | "src_ZCc",
    string
  >;
  for (const key of keys) {
    patterns[key] = patterns[key].replaceAll(
      patterns.src_ZCc,
      `${patterns.src_ZCc}|[。，、；！？（）【】「」『』《》“”‘’]`,
    );
  }
};
linkify.add("ftp:", null).add("mailto:", null).add("//", null);

export function RecordBody({
  body,
  className = "",
  onOpenLink,
}: {
  body: string;
  className?: string;
  onOpenLink?: (url: string) => void;
}) {
  const content = useMemo(() => {
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const match of linkify.match(body) ?? []) {
      if (!/^https?:\/\//i.test(match.url)) continue;
      parts.push(body.slice(offset, match.index));
      parts.push(
        <a
          key={match.index}
          href={match.url}
          target="_blank"
          rel="noopener noreferrer"
          className="pointer-events-auto relative text-primary underline underline-offset-4"
          onClick={(event) => {
            event.stopPropagation();
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            if (onOpenLink) {
              event.preventDefault();
              onOpenLink(match.url);
            } else if (window.electronAPI?.openExternal) {
              event.preventDefault();
              void window.electronAPI.openExternal(match.url);
            }
          }}
        >
          {body.slice(match.index, match.lastIndex)}
        </a>,
      );
      offset = match.lastIndex;
    }
    parts.push(body.slice(offset));
    return parts;
  }, [body, onOpenLink]);

  // Keep the original text, including whitespace and punctuation, unchanged.
  return (
    <p className={`whitespace-pre-wrap break-words leading-7 ${className}`}>
      {content}
    </p>
  );
}
export function SuijiAttachmentView({
  attachment,
  client,
}: {
  attachment: SuijiAttachment;
  client: SuijiClient;
}) {
  const [value, setValue] = useState<{ url?: string; text?: string }>(),
    [error, setError] = useState("");
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true,
      url: string | undefined;
    setBusy(true);
    setError("");
    void client
      .file(attachment.id)
      .then(async (blob) => {
        const text =
          attachment.kind === "markdown"
            ? new TextDecoder("utf-8", { fatal: true }).decode(
                await blob.arrayBuffer(),
              )
            : undefined;
        if (!active) return;
        if (text === undefined) url = URL.createObjectURL(blob);
        setValue({ text, url });
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : "附件读取失败");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, client, attachment.id, attachment.kind]);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {attachment.kind === "image" ? "图片" : "Markdown"} ·{" "}
        {attachment.fileName}
      </Button>
      {open ? (
        <SuijiPanel title={attachment.fileName} onBack={() => setOpen(false)}>
          {busy ? <p role="status">正在读取附件…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {value?.url ? (
            <img
              src={value.url}
              alt={attachment.fileName}
              className="max-h-[65dvh] w-full object-contain"
            />
          ) : null}
          {value?.text !== undefined ? (
            <pre className="whitespace-pre-wrap break-words text-sm leading-6">
              {value.text}
            </pre>
          ) : null}
        </SuijiPanel>
      ) : null}
    </>
  );
}

export function SuijiRecordDetail({
  record,
  onOpenLink,
  client,
  onClose,
  onEdit,
  onStatus,
  onTrash,
  onReview,
  onRecreate,
  writable,
  pending,
  busy,
  citedVersion,
}: {
  record: SuijiRecord;
  onOpenLink?: (url: string) => void;
  client: SuijiClient;
  onClose: () => void;
  onEdit: () => void;
  onStatus: (status: "open" | "done" | "archived") => void;
  onTrash: (trashed: boolean) => void;
  onReview: () => void;
  onRecreate: () => void;
  writable: boolean;
  pending: boolean;
  busy: boolean;
  citedVersion?: number;
}) {
  const [confirmTrash, setConfirmTrash] = useState(false);
  return (
    <SuijiPanel
      title={statusText(record)}
      description={recordDate(record.createdAt)}
      onBack={onClose}
    >
      {citedVersion !== undefined && citedVersion !== record.version ? (
        <p role="status" className="text-sm text-muted-foreground">
          此记录已更新；回答引用的是版本 {citedVersion}，下方是当前原文。
        </p>
      ) : null}
      <RecordBody body={record.body} onOpenLink={onOpenLink} />
      <div className="flex flex-wrap gap-2">
        {record.attachments.map((a) => (
          <SuijiAttachmentView key={a.id} attachment={a} client={client} />
        ))}
      </div>
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
          disabled={!writable || pending || busy || Boolean(record.deletedAt)}
          onClick={onEdit}
        >
          编辑
        </Button>
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
