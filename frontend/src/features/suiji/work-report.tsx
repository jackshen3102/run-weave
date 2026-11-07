import { useEffect, useState } from "react";
import type { WorkReport } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SuijiHttpError } from "../../services/suiji";
import type { PendingRequest } from "./drafts";
import type { WorkRecordModel } from "./work-record-model";

type Draft = { title: string; body: string; version: number; pending?: PendingRequest };
export function WorkReportCard({ report, onOpen }: { report: WorkReport; onOpen: () => void }) {
  const incomplete = report.days.filter(d => d.coverage !== "complete");
  return <button type="button" onClick={onOpen} className="rounded-2xl border border-emerald-600/40 bg-emerald-50/40 p-4 text-left dark:bg-emerald-950/20">
    <p className="mb-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">周报 · {report.from} — {report.to}</p>
    <h3 className="mb-2 font-semibold">{report.title}</h3>
    <p className="line-clamp-2 whitespace-pre-wrap text-sm leading-7">{report.body.replace(/[#*]/g, "")}</p>
    <p className="mt-3 text-xs text-muted-foreground">{incomplete.length ? `${incomplete.length} 天来源尚未齐全 · ` : ""}查看完整周报 →</p>
  </button>;
}
export function WorkReportDetail({ original, model, writable, onClose, onLogs }: {
  original: WorkReport; model: WorkRecordModel; writable: boolean; onClose: () => void; onLogs: () => void;
}) {
  const [report, setReport] = useState(original), [draft, setDraft] = useState<Draft>(), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const key = "work:report:" + original.id;
  useEffect(() => {
    let active = true;
    void Promise.all([model.client.request<{ report: WorkReport }>("/api/suiji/v1/work-reports/" + original.id), model.store.get<Draft>(key)])
      .then(([value, saved]) => { if (active && model.client.active) { setReport(value.report); setDraft(saved); } }, e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [original.id, model, key]);
  const persist = async (next: Draft) => { if (model.client.active) setDraft(next); await model.persistReportDraft(key, next); };
  const start = async () => { try { if (!draft) await persist({ title: report.title, body: report.body, version: report.version }); setEditing(true); } catch (e) { setError(String(e)); } };
  const save = async () => {
    if (!draft || busy || !writable) return;
    setBusy(true); setError(""); let current = draft;
    try {
      if (!current.pending) {
        if (!current.title.trim() || [...current.title.trim()].length > 80 || !current.body.trim() || [...current.body].length > 20000) throw new Error("标题1–80字，正文1–20000字");
        current = { ...current, pending: { path: "/api/suiji/v1/work-reports/" + report.id, method: "PATCH", key: crypto.randomUUID(), data: { title: current.title.trim(), body: current.body, expectedVersion: current.version } } };
        await persist(current);
      }
      const p = current.pending!;
      const result = await model.client.request<{ report: WorkReport }>(p.path, p.method, p.data, p.key);
      const expected = p.data as { title: string; body: string; expectedVersion: number };
      if (result.report.id !== report.id || result.report.body !== expected.body || result.report.title !== expected.title || result.report.version !== expected.expectedVersion + 1) throw new Error("保存回执不匹配，请手动确认原请求");
      await model.clearReportDraft(key);
      if (model.client.active) { setReport(result.report); setDraft(undefined); setEditing(false); await model.load(); }
    } catch (e) {
      if (e instanceof SuijiHttpError && !e.uncertain) await persist({ ...current, pending: undefined });
      if (model.client.active) setError(String(e));
    } finally { if (model.client.active) setBusy(false); }
  };
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="周报详情">
    <header className="flex items-center justify-between border-b p-4"><Button variant="ghost" disabled={busy} onClick={onClose}>返回工作</Button><span>周报</span><Button variant="ghost" disabled={busy || !writable} onClick={() => void (editing ? save() : start())}>{editing ? draft?.pending ? "手动确认原请求" : "保存" : "编辑周报"}</Button></header>
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">{report.from} — {report.to} · 七个自然日</p>
      {report.needsReview ? <p className="text-sm text-amber-600">来源含历史浏览内容，此周报待人工复核。</p> : null}
      <p className="text-xs text-muted-foreground">根据 {report.sourceFacts.length} 条工作事实整理{report.manuallyEdited ? " · 已人工编辑" : ""}</p>
      {report.days.some(d => d.coverage !== "complete") && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">来源未齐：{report.days.filter(d => d.coverage !== "complete").map(d => d.date).join("、")}。未上报不代表没有工作。</p>}
      {editing && draft ? <><label className="block text-sm">周报标题<Input aria-label="周报标题" value={draft.title} disabled={busy || !!draft.pending} onChange={e => void persist({ ...draft, title: e.target.value }).catch(e => setError(String(e)))} /></label><label className="block text-sm">周报正文<textarea aria-label="周报正文" className="min-h-80 w-full rounded-xl border bg-background p-3" value={draft.body} disabled={busy || !!draft.pending} onChange={e => void persist({ ...draft, body: e.target.value }).catch(e => setError(String(e)))} /></label>
      {draft.pending ? <p>保存结果待确认，返回或重启不会自动发送。</p> : <Button variant="outline" onClick={() => { void model.client.request<{ report: WorkReport }>("/api/suiji/v1/work-reports/" + report.id).then(async value => { setReport(value.report); await persist({ ...draft, version: value.report.version }); setError("已更新版本，保留草稿，请核对后保存。"); }, e => setError(String(e))); }}>读取最新版本并保留草稿</Button>}</> : <><h2 className="text-xl font-semibold">{report.title}</h2><div className="whitespace-pre-wrap break-words leading-8">{report.body}</div></>}
    </div><footer className="border-t p-4"><Button variant="outline" disabled={busy} onClick={onLogs}>查看原始日志</Button></footer>
  </section>;
}
