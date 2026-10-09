import { ArrowDown, BookOpen, RefreshCw } from "lucide-react";
import { useConversationReadingPosition } from "../../../features/terminal/conversation/reading-position";
import { useConversation } from "../../../features/terminal/conversation/use-conversation";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { TerminalMarkdownPreview } from "../preview/renderers/markdown";
import { Button } from "../../ui/button";

export function TerminalConversationPanel({ sessionId, panelId, projectId, title }: {
  sessionId: string; panelId: string | null; projectId: string; title: string;
}) {
  const { data, loading, error, unchanged, load } = useConversation(sessionId, panelId);
  const { apiBase, token, activeConnectionId, remote } = useTerminalRuntime();
  const positionKey = data?.target ? JSON.stringify([
    activeConnectionId ?? (apiBase.trim().replace(/\/+$/, "") || "same-origin"),
    remote?.endpointId ?? null, data.target.provider, data.target.threadId,
  ]) : null;
  const { scroll, capture, latest } = useConversationReadingPosition(positionKey, data?.readAt);
  const availability = data?.availability;
  const empty = availability === "no_thread" ? "当前终端暂无关联会话"
    : availability === "provider_unsupported" ? "当前 Agent 暂不支持会话阅读"
    : availability === "source_missing" ? "会话记录已不可用"
    : "暂无可读取的对话";
  return <section className="flex h-full min-h-0 flex-col bg-slate-950" aria-label="会话阅读">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
      <span className="flex items-center gap-2 text-sm font-medium text-emerald-200"><BookOpen className="h-4 w-4" />会话阅读</span>
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => { capture(); void load(); }}>
        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />{loading ? "读取中" : "刷新"}
      </Button>
    </div>
    {error ? <div role="alert" className="shrink-0 border-b border-rose-900 px-5 py-2 text-xs text-rose-200">{error}</div> : null}
    <div ref={scroll} onScroll={capture} data-testid="conversation-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
      <div className="mx-auto max-w-4xl px-5 py-7">
        <p className="text-xs text-emerald-300">{data?.target?.provider ?? "Agent"}</p>
        <h1 className="mb-2 mt-3 break-words text-2xl font-semibold text-slate-100">{title || "当前会话"}</h1>
        <p className="mb-7 text-xs text-slate-500">{data?.turns.length ?? 0} 轮对话</p>
        {data?.turns.map((turn, index) => <div key={turn.id} className="mb-7 border-t border-slate-800 pt-6">
          {turn.messages.map((message) => <article key={message.id} data-conversation-message={message.id}
            className={message.role === "user" ? "mb-5 rounded-xl border border-slate-700/70 bg-slate-900/70 p-4" : "mb-6 py-1"}>
            <div className="mb-2 flex items-center gap-2 text-xs text-emerald-200/70">
              <span>{message.role === "user" ? `你 · 第 ${index + 1} 轮` : data.target?.provider ?? "Agent"}</span>
              {message.createdAt && <time className="ml-auto text-slate-500">{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
            </div>
            <TerminalMarkdownPreview apiBase={apiBase} token={token} projectId={projectId}
              content={message.text} externalScroll onOpenFile={() => {}} />
          </article>)}
        </div>)}
        {!data?.turns.length ? <p className="py-12 text-center text-sm text-slate-400">{loading ? "正在读取会话…" : error && !data ? "点击刷新重试" : empty}</p> : null}
      </div>
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-800 px-5 py-3 text-xs text-slate-500" aria-live="polite">
      <span>{data ? `读取于 ${new Date(data.readAt).toLocaleTimeString()}` : "尚未读取"}{data?.partial ? " · 部分内容不可读" : unchanged ? " · 内容无变化" : ""}</span>
      <button className="flex items-center gap-1 text-emerald-200" onClick={latest}>回到最新<ArrowDown className="h-3 w-3" /></button>
    </footer>
  </section>;
}
