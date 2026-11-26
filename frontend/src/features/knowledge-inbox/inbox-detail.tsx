import type { InboxItem, InboxLiveCheckResult } from "@runweave/shared/knowledge-inbox";
import { useState, useRef, useEffect } from "react";
import { useMemoizedFn } from "ahooks";
import { Copy, RefreshCw } from "lucide-react";
import { runInboxLiveCheck, shareInboxItem } from "../../services/knowledge-inbox";
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
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<InboxLiveCheckResult | null>(item.liveCheck?.lastResult ?? null);
  const [checkMessage, setCheckMessage] = useState("");
  const checkRequest = useRef<AbortController | null>(null);
  // The parent remounts on account changes; a token refresh must not strand copying=true.
  const identity = `${apiBase}:${item.itemId}:${item.contentVersion}:${item.sourceRevision}`;
  const latestIdentity = useRef(identity);
  useEffect(() => {
    latestIdentity.current = identity;
    return () => { latestIdentity.current = ""; checkRequest.current?.abort(); };
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
  const liveCheck = useMemoizedFn(async () => {
    if (checking || !item.liveCheck?.supported) return;
    const started = identity;
    const controller = new AbortController();
    checkRequest.current?.abort();
    checkRequest.current = controller;
    setChecking(true); setCheckMessage("");
    try {
      const result = await runInboxLiveCheck(apiBase, token, item, controller.signal);
      if (latestIdentity.current !== started) return;
      setCheckResult(result);
    } catch (error) {
      if (controller.signal.aborted || latestIdentity.current !== started) return;
      setCheckMessage(error instanceof HttpError && error.status === 409
        ? "经验内容已更新，请刷新后重新复验" : "现场复验失败，请检查连接后重试");
    } finally {
      if (checkRequest.current === controller) checkRequest.current = null;
      if (latestIdentity.current === started) setChecking(false);
    }
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
      {item.liveCheck?.supported ? (
        <section className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
          <div>
            <h3 className="font-medium">现场复验</h3>
            <p className="mt-1 text-xs text-muted-foreground">使用产品内置的只读检查核对当前真实环境，不会自动修复或标记已处理。</p>
          </div>
          <Button variant="outline" onClick={() => void liveCheck()} disabled={checking || disabled || item.availability !== "available"}>
            <RefreshCw className={`mr-2 h-4 w-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? "正在复验…" : checkResult ? "重新复验" : "现场复验"}
          </Button>
          {checkResult ? <LiveCheckResult result={checkResult} /> : null}
          {checkMessage ? <p role="alert" className="text-sm text-destructive">{checkMessage}</p> : null}
        </section>
      ) : item.liveCheck ? <p className="text-xs text-muted-foreground">此经验暂无内置现场复验。</p> : null}
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

const CHECK_STATE_LABELS: Record<InboxLiveCheckResult["state"], string> = {
  passed: "通过", failed: "未通过", blocked: "无法判断", unsupported: "暂不支持",
};
function LiveCheckResult({ result }: { result: InboxLiveCheckResult }) {
  const tone = result.state === "passed" ? "text-emerald-700 dark:text-emerald-300"
    : result.state === "failed" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300";
  return (
    <div role="status" data-live-check-state={result.state} className="space-y-2 text-sm">
      <p className={tone}><span className="font-medium">{CHECK_STATE_LABELS[result.state]}</span>{` · ${result.summary}`}</p>
      {result.facts.length ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {result.facts.map((fact) => <div key={fact.id} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt><dd className="min-w-0 truncate font-mono">{fact.value}</dd>
        </div>)}
      </dl> : null}
      <p className="text-[11px] text-muted-foreground">检查于 {new Date(result.observedAt).toLocaleString()} · 有效期 {Math.max(1, Math.round(result.validForMs / 1000))} 秒</p>
    </div>
  );
}
