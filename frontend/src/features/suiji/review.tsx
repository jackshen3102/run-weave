import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  ReviewInput,
  ReviewScope,
  SuijiInfo,
  SuijiReview,
} from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import type { SuijiClient } from "../../services/suiji";
import { recordDate, statusText } from "./record";

type Turn = { question: string; job: SuijiReview };
export function SuijiReviewPanel({
  client,
  info,
  scope,
  onScope,
  onOpen,
  onSave,
  writable,
}: {
  client: SuijiClient;
  info: SuijiInfo;
  scope: ReviewScope;
  onScope: (scope: ReviewScope) => void;
  onOpen: (id: string, version: number) => void;
  onSave: (body: string, kind: "note" | "task") => void;
  writable: boolean;
}) {
  const [question, setQuestion] = useState(""),
    [turns, setTurns] = useState<Turn[]>([]);
  const [job, setJob] = useState<SuijiReview>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{ input: ReviewInput; key: string } | undefined>(
    undefined,
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = useMemoizedFn(async () => {
    if (busy || job?.status === "running") return;
    setBusy(true);
    setError("");
    pending.current ??= {
      key: crypto.randomUUID(),
      input: {
        question,
        scope,
        history: turns
          .flatMap((t) => [
            { role: "user" as const, text: t.question },
            { role: "assistant" as const, text: t.job.answer?.text ?? "" },
          ])
          .slice(-6),
      },
    };
    try {
      const next = await client.request<SuijiReview>(
        "/api/suiji/v1/reviews",
        "POST",
        pending.current.input,
        pending.current.key,
      );
      if (alive.current) setJob(next);
    } catch (reason) {
      if (alive.current)
        setError(
          (reason instanceof Error ? reason.message : "回顾请求失败") +
            "。问题保留，点击手动确认可重查同一次请求。",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  });
  const finish = useMemoizedFn((next: SuijiReview) => {
    setJob(next);
    if (next.status === "running") return;
    if (next.status === "completed") {
      setTurns((old) => [
        ...old,
        { question: pending.current?.input.question ?? question, job: next },
      ]);
      setQuestion("");
      setError("");
    } else
      setError(
        next.error ??
          (next.status === "cancelled" ? "已取消，原问题保留" : "回顾未完成"),
      );
    pending.current = undefined;
  });
  useEffect(() => {
    if (!job) return;
    if (job.status !== "running") {
      if (pending.current) finish(job);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.request<SuijiReview>(
          "/api/suiji/v1/reviews/" + job.id,
        );
        if (!active) return;
        if (next.status !== "running") finish(next);
        else timer = setTimeout(() => void poll(), 1500);
      } catch (reason) {
        if (active) {
          setError(
            (reason instanceof Error ? reason.message : "无法读取进度") +
              "。可手动查询此回顾的进度。",
          );
        }
      }
    };
    timer = setTimeout(() => void poll(), 800);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, job, finish]);
  const refresh = useMemoizedFn(async () => {
    if (!job) return;
    try {
      finish(
        await client.request<SuijiReview>("/api/suiji/v1/reviews/" + job.id),
      );
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "查询失败");
    }
  });
  const cancel = useMemoizedFn(async () => {
    if (!job) return;
    try {
      finish(
        await client.request<SuijiReview>(
          "/api/suiji/v1/reviews/" + job.id,
          "DELETE",
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "取消失败，请手动重试",
      );
    }
  });
  const running = busy || job?.status === "running";
  if (!info.ai?.enabled)
    return (
      <section className="flex flex-col gap-3 py-16 text-center">
        <h2 className="text-xl">AI 回顾尚未启用</h2>
        <p className="text-muted-foreground">
          当前服务没有可用的回顾模型。记录和待办仍可正常使用。
        </p>
      </section>
    );
  return (
    <section className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">从记录里，接着想</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          主动发问后才检索。回答引用实际原文，保存结论由你决定。
        </p>
      </header>
      {turns.map((turn) => (
        <article key={turn.job.id} className="flex flex-col gap-4">
          <p className="ml-8 rounded-2xl bg-secondary p-4 whitespace-pre-wrap">
            {turn.question}
          </p>
          <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5">
            <p className="whitespace-pre-wrap break-words leading-7">
              {turn.job.answer!.text}
            </p>
            {turn.job.answer!.citations.map((citation, index) => (
              <button
                key={index}
                className="flex flex-col gap-1 rounded-xl border p-3 text-left hover:bg-accent"
                onClick={() => onOpen(citation.recordId, citation.version)}
              >
                <span className="text-xs text-muted-foreground">
                  [{index + 1}] {recordDate(citation.createdAt)} ·{" "}
                  {statusText(citation)} · 版本 {citation.version}
                  {citation.attachment
                    ? ` · ${citation.attachment.fileName}`
                    : ""}
                </span>
                <span className="whitespace-pre-wrap break-words text-sm">
                  {citation.quote || "已读取图片附件"}
                </span>
              </button>
            ))}
            <p className="text-xs leading-5 text-muted-foreground">
              本次查看 {turn.job.answer!.coverage.listedRecords} 条摘要、
              {turn.job.answer!.coverage.readRecords} 条原文、
              {turn.job.answer!.coverage.attachmentReads}{" "}
              段附件。关键词检索，未启用向量索引，未读取外链。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!writable}
                onClick={() => onSave(turn.job.answer!.text, "note")}
              >
                另存笔记
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!writable}
                onClick={() => onSave(turn.job.answer!.text, "task")}
              >
                新建待办
              </Button>
            </div>
          </div>
        </article>
      ))}
      <form
        className="flex flex-col gap-3 rounded-2xl border bg-card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex items-center gap-3 text-sm">
          回顾范围
          <select
            aria-label="回顾范围"
            disabled={running || Boolean(pending.current)}
            value={scope.kind}
            onChange={(e) =>
              onScope({ kind: e.target.value as "all" | "open" })
            }
            className="rounded-lg border bg-background p-2"
          >
            <option value="all">全部历史</option>
            <option value="open">当前待办</option>
            {scope.kind === "record" ? (
              <option value="record">这条记录</option>
            ) : null}
          </select>
        </label>
        <label className="sr-only" htmlFor="suiji-question">
          向随记提问
        </label>
        <textarea
          id="suiji-question"
          value={question}
          disabled={running || Boolean(pending.current)}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={4000}
          placeholder="以前有哪些想做、后来放下的事？"
          className="min-h-28 resize-y rounded-xl border bg-background p-3 leading-6"
        />
        {running ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在检索与回顾，可以继续浏览记录…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {error && !busy ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                pending.current = undefined;
                setJob(undefined);
                setError("");
              }}
            >
              结束此次等待，重新提问
            </Button>
          ) : null}
          {job?.status === "running" ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => void refresh()}
              >
                查询进度
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancel()}
              >
                取消回顾
              </Button>
            </>
          ) : (
            <Button type="submit" disabled={busy || !question.trim()}>
              {pending.current ? "手动确认请求" : "发送"}
            </Button>
          )}
        </div>
      </form>
      <p className="text-xs text-muted-foreground">
        对话仅保留在当前页面会话，刷新后不会自动重新执行。服务上的回顾结果保留
        30 分钟。
      </p>
    </section>
  );
}
