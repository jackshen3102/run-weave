import { GitBranch, RefreshCw, Check } from "lucide-react";
import { BRANCH_UPDATES_LIMIT, branchUpdatesCountLabel, type BranchUpdatesResponse } from "@runweave/shared/terminal/branch-updates";
import { HttpError } from "../../../../services/http";
import { useBranchUpdatesReading } from "../../../../features/terminal/preview/branch-updates-reading";
import { Button } from "../../../ui/button";

export function BranchUpdatesView({ data, error, loading, refresh, readingKey, projectName, connectionName }: {
  data: BranchUpdatesResponse | undefined; error: Error | null; loading: boolean; refresh: () => void;
  readingKey: string; projectName: string; connectionName: string;
}) {
  const snapshot = data?.snapshot;
  const items = snapshot?.items.slice(0, BRANCH_UPDATES_LIMIT);
  const revision = snapshot ? `${snapshot.headOid}:${snapshot.baseOid}` : undefined;
  const { scroll, capture } = useBranchUpdatesReading(readingKey, revision);
  const stale = data?.state === "stale" || Boolean(error && snapshot);
  const unavailable = data?.state === "unavailable";
  return <section className="flex h-full min-h-0 flex-col" data-testid="branch-updates">
    <header className="shrink-0 border-b border-slate-800 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><GitBranch className="h-4 w-4" />主分支更新</h2>
        <Button size="sm" variant="outline" disabled={loading} onClick={refresh} aria-label="刷新主分支更新">
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? "animate-spin" : ""}`} />{loading ? "检查中…" : "刷新"}
        </Button>
      </div>
      <p className="mt-2 truncate text-[11px] text-slate-500">{connectionName} · {projectName}</p>
      {snapshot ? <>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded border border-sky-900 bg-sky-950/30 px-2 py-1 font-mono text-sky-300">{snapshot.baseRemote}/{snapshot.baseBranch}</span>
          <span className="text-slate-500">→</span>
          <span className="break-all rounded border border-slate-700 px-2 py-1 font-mono text-slate-300">{snapshot.currentBranch ?? snapshot.headOid.slice(0, 7)}</span>
        </div>
        <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11px] text-slate-400">
          <span>{items?.length ? `待同步提交 · ${branchUpdatesCountLabel(items.length)}` : "没有待同步提交"}</span>
          <span>{stale ? "上次成功检查" : "检查于"} {new Date(snapshot.checkedAt).toLocaleString()}</span>
        </div>
      </> : null}
    </header>
    {stale ? <p role="status" className="m-4 rounded border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-300">暂时无法更新主分支，以下为上次检查结果。</p> : null}
    <div ref={scroll} onScroll={capture} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {snapshot && items && !unavailable ? items.length ? <ol className="px-4">
        {items.map((item) => <li key={item.oid} data-commit-oid={item.oid} className="relative border-b border-slate-800 py-4 pl-5 last:border-0">
          <span className="absolute left-0 top-[22px] h-2 w-2 rounded-full border border-sky-400" />
          <p className="break-words text-xs leading-6 text-slate-200">{item.subject}</p>
          <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-500"><span className="font-mono text-slate-400">{item.oid.slice(0, 7)}</span><span>{item.authorName}</span><time className="ml-auto">{new Date(item.committedAt).toLocaleString()}</time></div>
        </li>)}
      </ol> : <div className="flex min-h-56 flex-col items-center justify-center gap-3 p-5 text-xs text-slate-400"><Check className="h-7 w-7 text-emerald-400" /><p>当前分支已包含主分支的全部提交</p></div>
        : <p role="status" className="p-5 text-xs text-slate-400">{loading ? "正在读取主分支更新…"
          : data?.state === "not-repository" ? "当前目录不是 Git 仓库"
          : error instanceof HttpError && error.status === 404 ? "当前后台暂时无法提供提交列表"
          : error instanceof HttpError && error.status === 409 ? "读取目标已变化或不可用，请重新打开"
          : data?.reason === "shallow-repository" ? "浅克隆仓库暂时无法比较主分支"
          : data?.reason === "unrelated-history" ? "当前提交与主分支没有共同历史"
          : "主分支更新暂不可用，请稍后刷新"}</p>}
    </div>
  </section>;
}
