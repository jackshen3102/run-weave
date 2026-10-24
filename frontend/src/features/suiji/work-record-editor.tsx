import type { WorkFactInput, WorkStatus } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { WorkRecordModel, workLabels } from "./work-record-model";
export function WorkRecordEditor({
  model,
  writable,
}: {
  model: WorkRecordModel;
  writable: boolean;
}) {
  const { draft, busy, error, detail } = model.state;
  if (!draft) return null;
  const locked = !writable || busy || Boolean(draft.pending),
    field = (key: keyof WorkFactInput, value: string) =>
      model.update({ [key]: value });
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="工作事实编辑">
      <header className="flex items-center justify-between border-b p-4">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => model.closeEditor()}
        >
          返回
        </Button>
        <h2>{draft.base ? "编辑事实" : "补记事实"}</h2>
        <Button disabled={busy || !writable} onClick={() => void model.save()}>
          {busy ? "保存中…" : draft.pending ? "手动确认原请求" : "保存"}
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {draft.pending ? (
          <p role="status" className="text-sm">
            保存结果待确认。原请求已保存在本机，返回或重启不会自动发送。
          </p>
        ) : null}
        <label className="space-y-2 text-sm">
          工作日期
          <Input
            type="date"
            aria-label="工作日期"
            disabled={locked}
            value={draft.fields.workDate}
            onChange={(e) => field("workDate", e.target.value)}
          />
        </label>
        <label className="space-y-2 text-sm">
          标题
          <Input
            aria-label="事实标题"
            disabled={locked}
            value={draft.fields.title}
            onChange={(e) => field("title", e.target.value)}
          />
        </label>
        <label className="space-y-2 text-sm">
          事实正文
          <textarea
            aria-label="事实正文"
            disabled={locked}
            className="min-h-48 w-full rounded-xl border bg-background p-3"
            value={draft.fields.statement}
            onChange={(e) => field("statement", e.target.value)}
          />
        </label>
        <label className="space-y-2 text-sm">
          实际状态
          <select
            aria-label="事实状态"
            disabled={locked}
            className="w-full rounded-xl border bg-background p-3"
            value={draft.fields.status}
            onChange={(e) =>
              model.update({ status: e.target.value as WorkStatus })
            }
          >
            {Object.entries(workLabels).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-2 text-sm">
          项目（可选）
          <Input
            aria-label="事实项目"
            placeholder="未归类"
            disabled={locked}
            value={draft.fields.project ?? ""}
            onChange={(e) => model.update({ project: e.target.value || null })}
          />
        </label>
        {draft.base && !draft.pending ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void model.refreshVersion()}
            >
              读取最新版本并保留草稿
            </Button>
            {detail?.id === draft.id ? (
              <div className="whitespace-pre-wrap rounded-xl bg-secondary p-3 text-sm">
                <p>
                  服务当前 v{detail.version} · {detail.workDate} ·{" "}
                  {detail.project ?? "未归类"}
                </p>
                <strong>{detail.title}</strong>
                <p>{detail.statement}</p>
              </div>
            ) : null}
          </>
        ) : null}
        <Button
          variant="ghost"
          disabled={locked}
          onClick={() => void model.discardEditor()}
        >
          丢弃未保存草稿
        </Button>
      </div>
    </section>
  );
}
