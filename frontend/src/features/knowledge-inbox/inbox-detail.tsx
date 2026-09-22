import type { InboxItem } from "@runweave/shared/knowledge-inbox";
import { useState, useRef, useEffect } from "react";
import { useMemoizedFn } from "ahooks";
import { Copy } from "lucide-react";
import { shareInboxItem } from "../../services/knowledge-inbox";
import { HttpError } from "../../services/http";
import { Button } from "../../components/ui/button";
export function InboxDetail({
  item,
  busy,
  disabled,
  onChange,
  apiBase,
  token,
}: {
  item: InboxItem;
  busy: boolean;
  disabled: boolean;
  onChange: () => void;
  apiBase: string;
  token: string;
}) {
  const [copying, setCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [copyText, setCopyText] = useState("");
  // The parent remounts on account changes; a token refresh must not strand copying=true.
  const identity = `${apiBase}:${item.itemId}:${item.contentVersion}:${item.sourceRevision}`;
  const latestIdentity = useRef(identity);
  useEffect(() => {
    latestIdentity.current = identity;
    return () => { latestIdentity.current = ""; };
  }, [identity]);
  const copy = useMemoizedFn(async () => {
    if (copying) return;
    const started = identity;
    setCopying(true); setCopyMessage(""); setCopyText("");
    try {
      const shared = await shareInboxItem(apiBase, token, item);
      if (latestIdentity.current !== started) return;
      setCopyText(shared.text);
      try {
        await navigator.clipboard.writeText(shared.text);
        if (latestIdentity.current === started) setCopyMessage("已复制，粘贴给 Agent 即可");
      } catch {
        if (latestIdentity.current === started) setCopyMessage("自动复制不可用，请复制下方内容");
      }
    } catch (error) {
      if (latestIdentity.current === started) setCopyMessage(error instanceof HttpError && error.status === 409
        ? "成果已变化，请刷新后重新复制" : "生成引用失败，请检查连接与服务版本后重试");
    } finally { if (latestIdentity.current === started) setCopying(false); }
  });
  return (
    <article className="space-y-5 rounded-2xl border border-border bg-card p-6">
      <div>
        <p className="text-xs text-muted-foreground">
          {item.projectName} · {item.source === "experience" ? "经验" : "洞察"}
        </p>
        <h2 className="mt-2 text-xl font-semibold">{item.title}</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {item.validationLabel} ·{" "}
          {new Date(item.contentUpdatedAt).toLocaleString()}
        </p>
      </div>
      {item.availability !== "available" ? (
        <p role="status" className="text-amber-600">
          {item.availability === "unknown" ? "来源暂不可用" : "已失效 / 不可用"}
        </p>
      ) : null}
      {item.currentContentVersion ? (
        <p className="text-amber-600">
          这是处理时的正文，当前已有新版本{item.hasUpdate ? "待处理" : ""}。
        </p>
      ) : null}
      {/* Plain text deliberately excludes raw HTML, scripts and remote-image loading. */}
      {item.statement ? (
        <p className="whitespace-pre-wrap text-sm leading-7">
          {item.statement}
        </p>
      ) : null}
      {item.applicability ? (
        <section>
          <h3 className="font-medium">适用条件</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
            {item.applicability}
          </p>
        </section>
      ) : null}
      {(
        [
          ["guidance", "建议"],
          ["actions", "步骤"],
          ["avoid", "避坑"],
          ["verification", "验证说明"],
        ] as const
      ).map(([key, label]) =>
        item[key]?.length ? (
          <section key={key}>
            <h3 className="font-medium">{label}</h3>
            <ol className="mt-2 list-inside list-decimal space-y-2 text-sm leading-7">
              {item[key]!.map((value, index) => (
                <li key={index} className="whitespace-pre-wrap">
                  {value}
                </li>
              ))}
            </ol>
          </section>
        ) : null,
      )}
      <Button variant="outline" onClick={() => void copy()} disabled={copying || disabled || item.availability !== "available"}>
        <Copy className="mr-2 h-4 w-4" />{copying ? "正在生成引用…" : "复制给 Agent"}
      </Button>
      {copyMessage ? <p role="status" className="text-sm text-muted-foreground">{copyMessage}</p> : null}
      {copyText && copyMessage.startsWith("自动复制") ? <textarea aria-label="成果交接内容" readOnly value={copyText} className="w-full rounded border p-3 text-sm" rows={6} onFocus={(event) => event.target.select()} /> : null}
      <Button
        onClick={onChange}
        disabled={busy || disabled || item.availability !== "available"}
      >
        {busy
          ? "正在保存…"
          : item.processedAt
            ? item.currentContentVersion
              ? "查看当前版本"
              : "恢复待处理"
            : "已处理"}
      </Button>
    </article>
  );
}
