import { useEffect, useState } from "react";
import type { AgentObserverSimulatorFrame, AgentObserverTerminalSource } from "@runweave/shared/terminal-browser-automation";

const PHASE = { running: "操作中", settling: "等待画面响应", idle: "空闲 · 已停止采集", private: "私密操作 · 暂停采集" };
export function ObserverSimulators({ visible, sources, expanded, expand }: {
  visible: boolean; sources: AgentObserverTerminalSource[]; expanded: string | null; expand: (id: string | null) => void;
}) {
  const [frames, setFrames] = useState<AgentObserverSimulatorFrame[]>([]);
  const [continuous, setContinuous] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await window.electronAPI?.agentObserverSimulators?.(continuous);
        if (!cancelled && result) { setFrames(result); setError(null); }
      } catch { if (!cancelled) setError("无法读取模拟器操作状态"); }
      finally { if (!cancelled) timer = setTimeout(() => void poll(), 1000); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, continuous]);
  useEffect(() => {
    if (expanded?.startsWith("simulator:") && !frames.some(frame => frame.id === expanded)) expand(null);
  }, [frames, expanded, expand]);
  return <>{error && <p role="alert">{error}</p>}{frames.map(frame => {
    const matching = sources.filter(source => source.terminalSessionId === frame.terminalSessionId);
    const source = matching.length === 1 ? matching[0] : null;
    const watching = continuous.includes(frame.id);
    return <section key={frame.id} aria-label={frame.name} className="flex min-h-80 flex-col overflow-hidden rounded border border-slate-800"
      style={{ display: expanded && expanded !== frame.id ? "none" : undefined, gridColumn: expanded ? "1 / -1" : undefined }}>
      <div className="flex flex-wrap items-center gap-2 bg-slate-900 p-2 text-xs">
        <span className="flex-1">{frame.name} · 自动跟随</span>
        <button onClick={() => expand(expanded === frame.id ? null : frame.id)}>{expanded === frame.id ? "还原" : "放大"}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 bg-slate-900 px-2 pb-2 text-xs">
        <span className="flex-1">{source ? `${source.label} · ${source.project}` : frame.terminalSessionId ? `来源终端 ${frame.terminalSessionId}` : "来源终端未提供"}</span>
        <button disabled={!source} onClick={() => { if (source) void window.electronAPI?.openAgentObserverTerminal?.(source); }}>返回终端</button>
        <label><input type="checkbox" checked={watching} disabled={frame.phase === "private"} onChange={event => setContinuous(current => event.target.checked ? [...current, frame.id] : current.filter(id => id !== frame.id))} /> 持续观察</label>
      </div>
      <p className="px-2 py-1 text-xs text-slate-400" data-phase={frame.phase} data-captured-at={frame.capturedAt}>
        {watching && frame.phase === "idle" ? "持续观察中" : PHASE[frame.phase]}{frame.phase === "running" ? ` · ${frame.action}` : ""}
        {frame.capturedAt > 0 && ` · 最后画面 ${new Date(frame.capturedAt).toLocaleTimeString()}`}
        {frame.error && ` · ${frame.error}`}
      </p>
      {frame.image ? <img className="min-h-0 flex-1 object-contain" src={frame.image} alt={frame.name} onDoubleClick={() => expand(expanded === frame.id ? null : frame.id)} /> :
        <p className="p-6 text-sm text-slate-400">{frame.phase === "private" ? "私密操作不显示画面" : "等待 Agent 操作模拟器"}</p>}
    </section>;
  })}</>;
}
