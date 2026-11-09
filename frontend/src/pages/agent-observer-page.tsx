import { useObserverSources } from "../features/terminal/automation-sources";
import { useEffect, useState } from "react";
import { TerminalBrowserAutomationTool } from "../components/terminal/automation/tool";

import type { AgentObserverWindowFrame } from "@runweave/shared/terminal-browser-automation";
import { ObserverSimulators } from "../components/terminal/automation/simulators";

export function AgentObserverPage() {
  const sources = useObserverSources();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [windows, setWindows] = useState<AgentObserverWindowFrame[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.electronAPI?.agentObserverWindows?.(selected);
        if (!cancelled && next) { setWindows(next); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "无法读取窗口画面");
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), selected.length ? 1000 : 5000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selected, visible]);
  const frames = selected.map(id => windows.find(item => item.id === id) ?? { id, name: "窗口已关闭", image: null, capturedAt: 0 });
  return <main className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
    <header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-slate-800 p-3">
      <h1 className="font-semibold">Agent 实时观察</h1>
      <span className="text-xs text-slate-400">浏览器与模拟器自动跟随 · 手动添加的窗口持续观察</span>
      <select aria-label="添加观察窗口" value="" className="max-w-80 rounded bg-slate-800 p-2 text-sm" disabled={selected.length >= 6}
        onChange={event => { const id = event.target.value; if (id) setSelected(current => [...current, id]); }}>
        <option value="">持续观察 Beta 或其他窗口…</option>
        {windows.filter(item => !selected.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </header>
    {error && <p role="alert" className="bg-rose-950 p-3 text-sm">画面更新中断：{error}</p>}
    <div className="grid min-h-0 flex-1 auto-rows-[minmax(320px,1fr)] gap-3 overflow-auto p-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(480px, 1fr))" }}>
      <section className="flex min-h-80 flex-col overflow-hidden rounded border border-slate-800" style={{ display: expanded && expanded !== "browser" ? "none" : undefined, gridColumn: expanded ? "1 / -1" : undefined }}>
        <button className="bg-slate-900 p-2 text-right text-xs" onClick={() => setExpanded(current => current === "browser" ? null : "browser")}>{expanded === "browser" ? "还原浏览器画面" : "放大浏览器画面"}</button><div className="min-h-0 flex-1"><TerminalBrowserAutomationTool active={visible && (!expanded || expanded === "browser")} sources={sources} /></div></section>
      <ObserverSimulators visible={visible} sources={sources} expanded={expanded} expand={setExpanded} />
      {frames.map(frame => <section key={frame.id} className="flex min-h-80 flex-col overflow-hidden rounded border border-slate-800" style={{ display: expanded && expanded !== frame.id ? "none" : undefined, gridColumn: expanded ? "1 / -1" : undefined }}>
        <div className="flex items-center gap-2 bg-slate-900 p-2 text-xs"><span className="min-w-0 flex-1 truncate">{frame.name} · 手动选择</span>
          <span>{frame.capturedAt ? new Date(frame.capturedAt).toLocaleTimeString() : "已断开"}</span>
          <button type="button" onClick={() => setExpanded(current => current === frame.id ? null : frame.id)}>{expanded === frame.id ? "还原" : "放大"}</button>
          <button type="button" aria-label={`移除 ${frame.name}`} onClick={() => { setSelected(current => current.filter(id => id !== frame.id)); if (expanded === frame.id) setExpanded(null); }}>移除</button></div>
        <div className="flex items-center gap-2 bg-slate-900 px-2 pb-2 text-xs">
          <select aria-label={`来源 Agent · ${frame.name}`} className="min-w-0 flex-1 bg-slate-800" value={bindings[frame.id] ?? ""} onChange={event => setBindings(current => ({ ...current, [frame.id]: event.target.value }))}>
            <option value="">来源 Agent 未关联（手动选择）</option>
            {sources.map(source => <option key={`${source.connectionId}:${source.terminalSessionId}`} value={`${source.connectionId}:${source.terminalSessionId}`}>{source.label} · {source.project}</option>)}
          </select>
          <button disabled={!sources.some(source => `${source.connectionId}:${source.terminalSessionId}` === bindings[frame.id])} onClick={() => {
            const source = sources.find(item => `${item.connectionId}:${item.terminalSessionId}` === bindings[frame.id]);
            if (source) void window.electronAPI?.openAgentObserverTerminal?.(source);
          }}>返回终端</button>
        </div>
        {frame.image ? <img className="min-h-0 flex-1 object-contain" src={frame.image} alt={frame.name} onDoubleClick={() => setExpanded(current => current === frame.id ? null : frame.id)} /> : <p className="p-6 text-sm text-slate-400">窗口画面不可用。请检查窗口是否打开及屏幕录制权限。</p>}
      </section>)}
    </div>
  </main>;
}
