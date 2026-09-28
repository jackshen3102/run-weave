import { useEffect, useState, useSyncExternalStore } from "react";
import type { CorrectionLexiconEntry, CorrectionTerm } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import type { SuijiEditorModel } from "./editor-model";

function segments(text: string, terms: CorrectionTerm[]) {
  const spellings = [...new Set(terms.map((term) => term.canonical))].filter(Boolean).sort((a, b) => b.length - a.length);
  const parts: Array<{ text: string; term?: CorrectionTerm }> = [];
  for (let at = 0; at < text.length;) {
    const spelling = spellings.find((word) => text.startsWith(word, at));
    if (spelling) { parts.push({ text: spelling, term: terms.find((term) => term.canonical === spelling) }); at += spelling.length; }
    else { const last = parts.at(-1); if (last && !last.term) last.text += text.charAt(at); else parts.push({ text: text.charAt(at) }); at++; }
  }
  return parts;
}

export function SuijiCorrectionPanel({ model, selectedText, available }: { model: SuijiEditorModel; selectedText: string; available: boolean }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  const [showOriginal, setShowOriginal] = useState(false);
  const [managing, setManaging] = useState(false);
  const [form, setForm] = useState<CorrectionTerm>();
  const [undo, setUndo] = useState<CorrectionLexiconEntry[]>();
  const [localMessage, setLocalMessage] = useState("");
  useEffect(() => { void model.loadLexicon(); }, [model]);
  const entries = state.lexicon?.entries ?? [];
  const remember = async () => {
    if (!form || !state.lexicon) return;
    const canonical = form.canonical.trim(), variant = form.variant.trim();
    if (!canonical) return;
    const before = structuredClone(entries);
    const next = structuredClone(entries);
    const existing = next.find((entry) => entry.canonical === canonical);
    if (existing) { if (variant && !existing.variants.includes(variant)) existing.variants.push(variant); }
    else next.push({ canonical, variants: variant ? [variant] : [] });
    if (JSON.stringify(next) === JSON.stringify(entries)) { setLocalMessage("这个写法已在词库中"); setForm(undefined); return; }
    try { await model.putLexicon(next); setUndo(before); setForm(undefined); }
    catch { /* The model keeps the request intent for explicit retry. */ }
  };
  const remove = async (canonical: string) => {
    try { await model.putLexicon(entries.filter((entry) => entry.canonical !== canonical)); }
    catch { /* Error is shown by the model. */ }
  };
  const correction = state.correction;
  const preview = correction?.status === "completed" && correction.correctedText;
  return <section className="space-y-3 rounded-xl border p-4 text-sm" aria-label="文字纠错">
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={!available || !state.draft.body.trim() || state.correctionBusy || state.draft.frozen} onClick={() => void model.correct()}>
        {state.correctionBusy ? "正在纠正…" : "纠正文字"}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setManaging(!managing)}>纠错词库</Button>
      {selectedText ? <Button type="button" variant="ghost" onClick={() => setForm({ canonical: selectedText, variant: "" })}>记住选词</Button> : null}
    </div>
    <p className="text-xs text-muted-foreground">点击后，本次文字和专有词库会经 Codex CLI 发送给模型提供方。</p>
    {!available ? <p className="text-xs text-muted-foreground">此服务尚未启用文字纠错；词库仍可管理。</p> : null}
    {state.correctionMessage || localMessage ? <p role="status">{localMessage || state.correctionMessage}</p> : null}
    {state.lexiconPending ? <Button type="button" variant="outline" onClick={() => void model.putLexicon(entries).then(() => { setUndo(entries); setForm(undefined); setLocalMessage(""); }).catch(() => undefined)}>手动重试确认词库写入</Button> : null}
    {preview ? <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2"><strong>纠错预览</strong><Button type="button" variant="ghost" onClick={() => setShowOriginal(!showOriginal)}>{showOriginal ? "收起原文" : "查看原文"}</Button></div>
      {showOriginal ? <p className="whitespace-pre-wrap break-words">{state.correctionSource}</p> : null}
      <p className="whitespace-pre-wrap break-words">{segments(correction.correctedText!, correction.suggestedTerms ?? []).map((part, index) =>
        part.term ? <button type="button" key={index} className="decoration-dotted underline underline-offset-4" onClick={() => setForm(part.term)}>{part.text}</button> : <span key={index}>{part.text}</span>)}</p>
      {correction.uncertainTerms?.length ? <p>仍不确定：{correction.uncertainTerms.join("、")}。请核对原文。</p> : null}
      <div className="flex gap-2"><Button type="button" onClick={() => model.applyCorrection()} disabled={state.draft.body !== state.correctionSource || state.draft.frozen}>应用到草稿</Button>
        <Button type="button" variant="outline" onClick={() => void model.cancelCorrection()}>取消</Button></div>
    </div> : null}
    {form ? <div className="space-y-2 rounded-lg border p-3">
      <strong>记住这个写法</strong>
      <label className="block">正确写法<input className="w-full rounded border bg-background p-2" value={form.canonical} onChange={(e) => setForm({ ...form, canonical: e.target.value })} /></label>
      <label className="block">误识别写法（可留空）<input className="w-full rounded border bg-background p-2" value={form.variant} onChange={(e) => setForm({ ...form, variant: e.target.value })} /></label>
      <div className="flex gap-2"><Button type="button" disabled={state.lexiconPending || !state.lexicon} onClick={() => void remember()}>加入词库</Button><Button type="button" variant="ghost" onClick={() => setForm(undefined)}>取消</Button></div>
    </div> : null}
    {undo ? <Button type="button" variant="ghost" onClick={() => { void model.putLexicon(undo).then(() => setUndo(undefined)).catch(() => undefined); }}>撤销本次添加</Button> : null}
    {managing ? <div className="space-y-2"><div className="flex justify-between"><strong>纠错词库</strong><Button type="button" variant="ghost" onClick={() => void model.loadLexicon()}>刷新</Button></div>
      {entries.map((entry) => <div key={entry.canonical} className="flex items-center justify-between gap-2 rounded border p-2"><span>{entry.canonical}{entry.variants.length ? ` ← ${entry.variants.join("、")}` : ""}</span><Button type="button" variant="ghost" onClick={() => void remove(entry.canonical)}>移除</Button></div>)}
      <Button type="button" variant="outline" onClick={() => setForm({ canonical: "", variant: "" })}>新增词条</Button>
    </div> : null}
  </section>;
}
