import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { ArrowLeft, LoaderCircle, Pencil, RefreshCw } from "lucide-react";
import type {
  SupervisionGoalContent,
  SupervisionGoalDetail,
  SupervisionGoalPreview,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import {
  applyTaskSupervisionGoal,
  getTaskSupervisionGoal,
  previewTaskSupervisionGoal,
} from "../../../services/task-supervision";
import { HttpError } from "../../../services/http";
import { Button } from "../../ui/button";

export type GoalView = "edit" | "generate" | "sources";
const fields = ["objective", "completionCriteria", "constraints"] as const;
const labels = {
  objective: "任务目标",
  completionCriteria: "完成条件",
  constraints: "范围与约束",
};
function content(watch: TaskWatch): SupervisionGoalContent {
  return (
    watch.goalDefinition ?? {
      objective: watch.goalOverride ?? watch.goal,
      completionCriteria: "",
      constraints: "",
    }
  );
}
function Lines({ text }: { text: string }) {
  return (
    <ul className="space-y-1 text-xs leading-6 text-slate-300">
      {text
        .split("\n")
        .filter(Boolean)
        .map((line, index) => (
          <li key={index} className="flex gap-2">
            <span className="text-slate-500">▫</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {line}
            </span>
          </li>
        ))}
    </ul>
  );
}
export function SupervisionGoalCard({
  watch,
  disabled,
  open,
}: {
  watch: TaskWatch;
  disabled: boolean;
  open: (view: GoalView) => void;
}) {
  const goal = watch.goalDefinition;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] text-slate-400">当前目标</h3>
        <span className="text-[11px] text-slate-400">
          {goal
            ? `${goal.origin === "manual" ? "手动修订" : "根据对话整理"} · v${goal.version}`
            : "待核对"}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">
        {goal?.objective ||
          watch.goal ||
          "等待新会话的用户任务，目标将自动读取。"}
      </p>
      {goal && (
        <>
          <h4 className="text-[11px] text-slate-400">完成条件</h4>
          <Lines text={goal.completionCriteria} />
          {goal.constraints && (
            <details>
              <summary className="cursor-pointer text-xs text-sky-400">
                范围与约束
              </summary>
              <div className="mt-2">
                <Lines text={goal.constraints} />
              </div>
            </details>
          )}
        </>
      )}
      {(watch.goalState === "needs_review" ||
        (!goal && !watch.taskStartMessageId.startsWith("pending:"))) && (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 p-3 text-xs leading-6 text-amber-300">
          {watch.goalReason ??
            "当前目标尚未明确完成条件和范围，请核对后再自动续接。"}
        </p>
      )}
      {watch.goalState === "checking" && (
        <p className="text-xs text-slate-400">
          收到新要求，将在最终回复时核对目标；核对前不自动续接。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => open("edit")}
        >
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          编辑
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => open("generate")}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          重新生成
        </Button>
        {goal && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            className="text-sky-400"
            onClick={() => open("sources")}
          >
            查看依据
          </Button>
        )}
      </div>
      {watch.goalReason && watch.goalState === "ready" && (
        <p className="text-[11px] leading-5 text-slate-500">
          {watch.goalReason}
        </p>
      )}
    </section>
  );
}
export function GoalSources({ detail }: { detail: SupervisionGoalDetail }) {
  const required = new Set([
    ...detail.goal.sourceMessageIds,
    ...detail.goal.plans.flatMap((p) => [
      p.sourceMessageId,
      p.authorizationMessageId,
    ]),
  ]);
  return (
    <div className="space-y-4">
      <p className="text-xs leading-6 text-slate-400">{detail.reason}</p>
      {detail.messages
        .filter((m) => required.has(m.id))
        .map((message) => (
          <article
            key={message.id}
            className="border-l-2 border-slate-700 pl-3"
          >
            <p className="mb-1 text-[11px] text-slate-400">
              {message.role === "user" ? "你" : "Agent"}
              {message.id.startsWith("goal-manual:")
                ? " · 监控面板修订"
                : ""} ·{" "}
              {message.createdAt
                ? new Date(message.createdAt).toLocaleString()
                : "原会话"}
            </p>
            <p className="whitespace-pre-wrap break-words text-xs leading-6">
              {message.text}
            </p>
            {detail.goal.plans
              .filter((p) => p.authorizationMessageId === message.id)
              .map((p) => (
                <p key={p.path} className="mt-2 break-all text-xs text-sky-400">
                  已承接计划：{p.path}
                </p>
              ))}
          </article>
        ))}
      {detail.plans.map((plan) => (
        <details
          key={plan.path}
          className="rounded border border-slate-800 p-3"
        >
          <summary className="cursor-pointer break-all text-xs text-sky-400">
            {plan.path} ·{" "}
            {plan.availability === "missing" ? "缺失" : "当时读取的内容"}
          </summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-6 text-slate-400">
            {plan.text || "未取得计划正文。"}
          </pre>
        </details>
      ))}
    </div>
  );
}

export function SupervisionGoalPanel({
  watch,
  initialView,
  offline,
  close,
  refresh,
  applied,
}: {
  watch: TaskWatch;
  initialView: GoalView;
  offline: boolean;
  close: () => void;
  refresh: () => Promise<unknown>;
  applied: () => void;
}) {
  const { apiBase, token, onAuthExpired } = useTerminalRuntime();
  const [view, setView] = useState<GoalView | "review">(initialView);
  const [base, setBase] = useState(watch);
  const [draft, setDraft] = useState<SupervisionGoalContent>(() =>
    content(watch),
  );
  const [preview, setPreview] = useState<SupervisionGoalPreview | null>(null);
  const [sources, setSources] = useState<SupervisionGoalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const applying = useRef(false);
  const [expired, setExpired] = useState(false);
  const fail = useMemoizedFn((failure: unknown) => {
    if (failure instanceof HttpError && failure.status === 401)
      onAuthExpired?.();
    setError(failure instanceof Error ? failure.message : "目标处理失败。");
  });
  const generate = useMemoizedFn(async (manual: boolean, fresh = false) => {
    if (offline || applying.current) return;
    if (
      manual &&
      (!draft.objective.trim() || !draft.completionCriteria.trim())
    ) {
      setError("请填写任务目标和完成条件。");
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const snapshot = fresh ? watch : base;
    if (fresh) setBase(watch);
    setError(null);
    setBusy(true);
    if (!manual) setView("generate");
    try {
      const result = await previewTaskSupervisionGoal(
        apiBase,
        token,
        watch.watchId,
        {
          expectedRevision: snapshot.revision,
          ...(manual
            ? {
                content: {
                  objective: draft.objective,
                  completionCriteria: draft.completionCriteria,
                  constraints: draft.constraints,
                },
              }
            : {}),
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPreview(result);
        setExpired(false);
        setView("review");
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        fail(failure);
        void refresh();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  });
  const loadSources = useMemoizedFn(async () => {
    if (!watch.goalDefinition) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setError(null);
    setBusy(true);
    try {
      const result = await getTaskSupervisionGoal(
        apiBase,
        token,
        watch.watchId,
        watch.goalDefinition.revisionId,
        controller.signal,
      );
      if (!controller.signal.aborted) setSources(result);
    } catch (failure) {
      if (!controller.signal.aborted) fail(failure);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  });
  useEffect(() => {
    mounted.current = true;
    if (initialView === "generate") void generate(false);
    if (initialView === "sources") void loadSources();
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, [initialView, generate, loadSources]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  const apply = useMemoizedFn(async () => {
    if (!preview || applying.current || offline) return;
    applying.current = true;
    setBusy(true);
    setError(null);
    try {
      await applyTaskSupervisionGoal(
        apiBase,
        token,
        watch.watchId,
        preview.previewId,
      );
      await refresh();
      if (mounted.current) applied();
    } catch (failure) {
      if (mounted.current) {
        fail(failure);
        void refresh();
      }
    } finally {
      applying.current = false;
      if (mounted.current) setBusy(false);
    }
  });
  const stale =
    !!preview && (expired || watch.revision !== preview.expectedRevision);
  const title =
    view === "edit"
      ? "编辑目标"
      : view === "review"
        ? "核对目标变更"
        : view === "sources"
          ? "目标依据"
          : "重新生成目标";
  const changed = fields.filter(
    (field) => preview && content(base)[field] !== preview.goal[field],
  );
  return (
    <section
      className="flex h-full min-h-0 flex-col text-slate-200"
      aria-label={title}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 p-4">
        <Button
          size="sm"
          variant="ghost"
          aria-label="返回监控"
          disabled={applying.current}
          onClick={close}
          className="h-7 w-7 p-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-[11px] text-slate-400">
            {view === "sources"
              ? `目标 v${sources?.goal.version ?? watch.goalDefinition?.version ?? 0} · 用户原文与承接关系`
              : view === "review"
                ? "核对任务范围 · 尚未生效"
                : `当前任务 · 目标 v${base.goalDefinition?.version ?? 0}`}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {offline && (
          <p className="text-xs text-amber-300">
            连接暂不可用，恢复后可修改目标。
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs leading-6 text-amber-300">
            {error}
          </p>
        )}
        {stale && (
          <p
            role="alert"
            className="rounded border border-amber-900/50 p-3 text-xs leading-6 text-amber-300"
          >
            任务状态或对话已变化，当前预览不能采用。请基于最新状态重新核对。
          </p>
        )}
        {view === "edit" && (
          <>
            {fields.map((field) => (
              <label
                key={field}
                className="block text-xs"
                htmlFor={`supervision-${field}`}
              >
                <span className="mb-2 block">{labels[field]}</span>
                <textarea
                  id={`supervision-${field}`}
                  rows={field === "constraints" ? 5 : 4}
                  maxLength={field === "objective" ? 1500 : 2000}
                  value={draft[field]}
                  disabled={busy || offline}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      [field]: event.target.value,
                    }))
                  }
                  className="w-full resize-y rounded-md border border-slate-700 bg-slate-900 p-3 text-sm leading-6 outline-none focus:border-sky-400"
                />
              </label>
            ))}
            <p className="text-[11px] text-slate-500">
              后续“继续”和进度询问会沿用修订后的目标。
            </p>
          </>
        )}
        {busy && view !== "edit" && (
          <div
            role="status"
            className="flex items-center gap-2 py-4 text-xs text-slate-400"
          >
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {applying.current ? "正在采用目标…" : "正在读取并核对原始来源…"}
          </div>
        )}
        {view === "review" && preview && (
          <>
            <div className="text-xs text-slate-400">
              v{base.goalDefinition?.version ?? 0}
              {preview.changed
                ? ` → v${preview.goal.version}`
                : " · 目标内容无变化"}
            </div>
            <p
              className={`text-xs leading-6 ${preview.needsClarification ? "text-amber-300" : "text-slate-400"}`}
            >
              {preview.reason}
            </p>
            {changed.map((field) => (
              <section key={field} className="space-y-3">
                <h3 className="text-xs font-medium">{labels[field]}</h3>
                <div className="rounded border border-slate-800 p-3">
                  <p className="mb-2 text-[11px] text-slate-500">当前</p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-400">
                    {content(base)[field] || "未明确"}
                  </p>
                </div>
                <div className="rounded border border-sky-900 bg-sky-950/20 p-3">
                  <p className="mb-2 text-[11px] text-slate-400">更新后</p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6">
                    {preview.goal[field] || "未设置"}
                  </p>
                </div>
              </section>
            ))}
            <details>
              <summary className="cursor-pointer text-xs text-sky-400">
                本次整理依据
              </summary>
              <div className="mt-4">
                <GoalSources detail={preview} />
              </div>
            </details>
            <p className="text-[11px] leading-5 text-slate-500">
              采用后按新目标重新判断。历史记录保留当时的目标。
            </p>
          </>
        )}
        {view === "sources" && sources && <GoalSources detail={sources} />}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-800 p-4">
        <Button
          size="sm"
          variant="ghost"
          disabled={applying.current}
          onClick={close}
        >
          {view === "review"
            ? "保留当前目标"
            : view === "sources"
              ? "返回监控"
              : "取消"}
        </Button>
        {view === "edit" && (
          <Button
            size="sm"
            disabled={busy || offline}
            onClick={() => void generate(true, !!error)}
          >
            {busy ? "正在核对…" : error ? "基于最新状态核对" : "查看变更"}
          </Button>
        )}
        {view === "generate" && !busy && (
          <Button
            size="sm"
            disabled={offline}
            onClick={() => void generate(false, true)}
          >
            重试
          </Button>
        )}
        {view === "sources" && error && (
          <Button
            size="sm"
            disabled={busy || offline}
            onClick={() => void loadSources()}
          >
            重试
          </Button>
        )}
        {view === "review" &&
          (stale ? (
            <Button
              size="sm"
              disabled={busy || offline}
              onClick={() => void generate(initialView === "edit", true)}
            >
              重新核对
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={
                busy ||
                offline ||
                !preview?.requiresAdoption ||
                preview.needsClarification
              }
              onClick={() => void apply()}
            >
              采用并重新判断
            </Button>
          ))}
      </footer>
    </section>
  );
}
