import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { WorkRecordModel, workLabels, workToday } from "./work-record-model";
import { WorkRecordEditor } from "./work-record-editor";
import { WorkReclassification } from "./work-reclassification";
export function WorkRecords({
  model,
  active,
  writable,
  onReview,
}: {
  model: WorkRecordModel;
  active: boolean;
  writable: boolean;
  onReview: () => void;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot),
    [dates, setDates] = useState(false),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [menu, setMenu] = useState(false);
  useEffect(() => {
    model.writable = writable;
  }, [model, writable]);
  useEffect(() => {
    if (active) void model.load();
  }, [active, model]);
  const { detail, draft, batch } = state;
  const dayTitle = (date: string) => {
    const delta = Math.round(
      (Date.parse(workToday() + "T00:00:00Z") -
        Date.parse(date + "T00:00:00Z")) /
        86400000,
    );
    return `${delta === 0 ? "今天 · " : delta === 1 ? "昨天 · " : delta === 2 ? "前天 · " : ""}${date}`;
  };
  const empty = () => {
    const days =
      state.from && state.to
        ? Math.floor(
            (Date.parse(state.to) - Date.parse(state.from)) / 86400000,
          ) + 1
        : 0;
    if (
      days > 0 &&
      state.days.length === days &&
      state.days.every((d) => d.coverage === "complete" && d.count === 0)
    )
      return "已导入范围内没有记录";
    return state.days.some((d) => d.coverage === "partial")
      ? "记录尚未完整导入"
      : "这个日期范围尚未导入工作记录";
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={
          draft || batch || detail ? "hidden" : "flex min-h-0 flex-1 flex-col"
        }
      >
        <header className="flex shrink-0 items-center justify-between px-5 py-3">
          <h1 className="text-lg font-semibold">工作</h1>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFrom(state.from);
                setTo(state.to);
                setDates((v) => !v);
              }}
            >
              日期
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="工作更多"
              onClick={() => setMenu((v) => !v)}
            >
              更多
            </Button>
          </div>
        </header>
        {menu ? (
          <div className="flex flex-wrap gap-2 border-y px-5 py-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={state.loading}
              onClick={() => {
                setMenu(false);
                void model.load();
              }}
            >
              刷新工作
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMenu(false);
                onReview();
              }}
            >
              AI 回顾
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!writable}
              onClick={() => {
                setMenu(false);
                void model.beginBatch([]);
              }}
            >
              重新归类
            </Button>
            {state.undo ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={!writable}
                onClick={() => {
                  setMenu(false);
                  void model.undo();
                }}
              >
                撤销上次归类
              </Button>
            ) : null}
          </div>
        ) : null}
        {dates ? (
          <form
            className="flex flex-col gap-3 border-y p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!from || !to || from <= to) {
                setDates(false);
                void model.dates(from, to);
              }
            }}
          >
            <label className="text-sm">
              开始日期
              <Input
                type="date"
                aria-label="开始日期"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              结束日期
              <Input
                type="date"
                aria-label="结束日期"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            {from && to && from > to ? (
              <p role="alert" className="text-sm text-destructive">
                开始日期不能晚于结束日期
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={Boolean(from && to && from > to)}>
                应用日期
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDates(false);
                  void model.dates("", "");
                }}
              >
                清空日期
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDates(false)}
              >
                取消
              </Button>
            </div>
          </form>
        ) : null}
        {state.from || state.to ? (
          <p className="px-5 pb-2 text-sm text-muted-foreground">
            {state.from || "最早"} 至 {state.to || "最近"}
          </p>
        ) : null}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 pb-24"
          aria-label="工作事实列表"
        >
          {state.error ? (
            <p role="alert" className="py-3 text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          {[...new Set(state.items.map((i) => i.workDate))].map((date) => (
            <section key={date} className="pb-5">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {dayTitle(date)}{" "}
                <span>
                  · {state.days.find((d) => d.date === date)?.count ?? "…"} 条
                </span>
              </h2>
              <div className="flex flex-col gap-3">
                {state.items
                  .filter((i) => i.workDate === date)
                  .map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => void model.detail(f.id)}
                      className="rounded-2xl border bg-card p-4 text-left"
                    >
                      <p className="mb-2 text-xs text-muted-foreground">
                        {f.project ?? "未归类"} · {workLabels[f.status]}
                      </p>
                      <h3 className="mb-2 font-semibold">{f.title}</h3>
                      <p className="whitespace-pre-wrap break-words text-sm leading-7">
                        {f.statement}
                      </p>
                    </button>
                  ))}
              </div>
            </section>
          ))}
          {!state.loading && !state.items.length ? (
            <p className="py-16 text-center text-muted-foreground">{empty()}</p>
          ) : null}
          {state.loading ? (
            <p role="status" className="py-8 text-center">
              正在读取工作事实…
            </p>
          ) : null}
          {state.cursor ? (
            <Button
              variant="outline"
              className="w-full"
              disabled={state.loading}
              onClick={() => void model.load(true)}
            >
              加载更多工作记录
            </Button>
          ) : null}
        </div>
        <Button
          aria-label="补记工作事实"
          className="absolute bottom-5 right-5 size-12 rounded-full text-2xl shadow-lg"
          disabled={!writable}
          onClick={() => void model.edit()}
        >
          +
        </Button>
      </div>
      {detail && !draft && !batch ? (
        <section
          className="flex min-h-0 flex-1 flex-col"
          aria-label="工作事实详情"
        >
          <header className="flex items-center justify-between border-b p-4">
            <Button variant="ghost" onClick={() => model.closeDetail()}>
              返回工作
            </Button>
            <Button
              variant="ghost"
              disabled={!writable}
              onClick={() => void model.edit(detail)}
            >
              编辑事实
            </Button>
          </header>
          <div className="flex-1 overflow-y-auto p-5">
            <p className="mb-3 text-sm text-muted-foreground">
              {detail.workDate} · {detail.project ?? "未归类"} ·{" "}
              {workLabels[detail.status]}
            </p>
            <h2 className="mb-4 text-xl font-semibold">{detail.title}</h2>
            <p className="mb-6 whitespace-pre-wrap break-words leading-8">
              {detail.statement}
            </p>
            <Button
              variant="outline"
              disabled={!writable}
              onClick={() => void model.beginBatch([detail])}
            >
              重新归类这条
            </Button>
          </div>
        </section>
      ) : null}
      {draft ? (
        <WorkRecordEditor model={model} writable={writable} />
      ) : batch ? (
        <WorkReclassification model={model} writable={writable} />
      ) : null}
    </div>
  );
}
