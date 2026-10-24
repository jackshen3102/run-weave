import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { WorkRecordModel } from "./work-record-model";
export function WorkReclassification({
  model,
  writable,
}: {
  model: WorkRecordModel;
  writable: boolean;
}) {
  const { batch, items, busy, error, undo } = model.state;
  if (!batch) return null;
  const locked = !writable || busy || Boolean(batch.pending),
    selected = new Set(batch.rows.map((r) => r.id));
  const rows = [...batch.rows, ...items.filter((i) => !selected.has(i.id))];
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="重新归类">
      <header className="flex items-center justify-between border-b p-4">
        <h2>{batch.undo ? "撤销本次归类" : "重新归类"}</h2>
        <Button
          variant="ghost"
          disabled={locked}
          onClick={() => void model.cancelBatch()}
        >
          取消
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {batch.pending ? (
          <p>操作结果待确认，原请求已保存在本机；不会自动重发。</p>
        ) : null}
        {batch.undo ? (
          <p>
            按原成功回执的版本还原 {undo?.items.length ?? 0}{" "}
            条记录的项目；任何一条版本变化将整批停止。
          </p>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={locked}
              onClick={() => void model.refreshBatch()}
            >
              读取所选事实最新版本
            </Button>
            <p className="text-sm">
              已选 {batch.rows.length} 条。仅修改项目，正文、日期和状态保持。
            </p>
            <Button
              variant="outline"
              disabled={locked || items.length > 100}
              onClick={() =>
                model.updateBatch(
                  [
                    ...new Map(
                      [...batch.rows, ...items].map((i) => [i.id, i]),
                    ).values(),
                  ],
                  batch.project,
                )
              }
            >
              全选已加载记录
            </Button>
            {model.state.cursor ? (
              <p className="text-sm text-muted-foreground">
                还有未加载记录；返回列表加载后再选择。
              </p>
            ) : null}
            <label className="text-sm">
              目标项目（留空为未归类）
              <Input
                aria-label="目标项目"
                list="work-projects"
                disabled={locked}
                value={batch.project}
                onChange={(e) => model.updateBatch(batch.rows, e.target.value)}
              />
            </label>
            <datalist id="work-projects">
              {[
                ...new Set(
                  items
                    .map((i) => i.project)
                    .filter((p): p is string => Boolean(p)),
                ),
              ].map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <div className="flex flex-col gap-3">
              {rows.map((f) => (
                <label
                  key={f.id}
                  className="flex items-start gap-3 rounded-xl border p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    aria-label={`选择 ${f.title}`}
                    disabled={
                      locked ||
                      (!selected.has(f.id) && batch.rows.length >= 100)
                    }
                    checked={selected.has(f.id)}
                    onChange={(e) =>
                      model.updateBatch(
                        e.target.checked
                          ? [...batch.rows, f]
                          : batch.rows.filter((i) => i.id !== f.id),
                        batch.project,
                      )
                    }
                  />
                  <span>
                    <strong>{f.title}</strong>
                    <br />
                    {f.workDate} · {f.project ?? "未归类"}
                    <br />
                    <small>{f.id}</small>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="shrink-0 border-t bg-background p-4">
        <Button
          className="h-auto min-h-10 w-full whitespace-normal break-words"
          disabled={!writable || busy || (!batch.undo && !batch.rows.length)}
          onClick={() => void model.commitBatch()}
        >
          {busy
            ? "保存中…"
            : batch.pending
              ? "手动确认原请求"
              : batch.undo
                ? "确认撤销项目调整"
                : `确认 ${batch.rows.length} 条 → ${batch.project.trim() || "未归类"}`}
        </Button>
      </div>
    </section>
  );
}
