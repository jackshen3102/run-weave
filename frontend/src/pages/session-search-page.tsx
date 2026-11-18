import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { SessionSearchContext, SessionSearchHit, SessionSearchLevel, SessionSearchProvider, SessionSearchResponse, SessionSearchStatus } from "@runweave/shared/session-search";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { HttpError } from "../services/http";
import { sessionSearchClient } from "../services/session-search";
import { listTerminalProjects } from "../services/terminal/projects";
import { useTerminalWorkspaceStore } from "../features/terminal/state/workspace-store";

interface Props { apiBase: string; token: string; connectionGeneration: number; onAuthExpired(): void }
const levels = [{ id: "chat", label: "对话" }, { id: "work", label: "对话与操作" }, { id: "full", label: "含工具输出" }] as const;
const kindLabel = { user: "用户", assistant: "模型", request: "工具请求", result: "工具结果", file_change: "文件变更", context: "上下文" };

function Choice({ label, value, onChange, items }: { label: string; value: string; onChange(value: string): void; items: { id: string; label: string }[] }) {
  return <label className="flex min-w-40 flex-col gap-2 text-sm">{label}
    <Select value={value} onValueChange={next => { if (next) onChange(next); }}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </label>;
}

function RecordText({ hit }: { hit: SessionSearchHit }) {
  return <article className="flex flex-col gap-2 rounded-md border p-3">
    <p className="text-sm text-muted-foreground">{kindLabel[hit.kind]} · {hit.toolName ?? hit.provider} · {hit.occurredAt ? new Date(hit.occurredAt).toLocaleString() : "时间未知"}</p>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{hit.text || "原文已变化，无法核对此内容。请更新索引后重新搜索。"}</pre>
    <p className="break-all text-xs text-muted-foreground">{hit.location.path}:{hit.location.line}</p>
  </article>;
}

export function SessionSearchPage({ apiBase, token, connectionGeneration, onAuthExpired }: Props) {
  const activeProject = useTerminalWorkspaceStore(state => state.activeParentProjectId);
  const [projects, setProjects] = useState<TerminalProjectListItem[]>([]);
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [level, setLevel] = useState<SessionSearchLevel>("chat");
  const [others, setOthers] = useState(false);
  const [result, setResult] = useState<SessionSearchResponse>();
  const [context, setContext] = useState<SessionSearchContext>();
  const [status, setStatus] = useState<SessionSearchStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  const revision = useRef(0);
  const scope = `${apiBase}:${token}:${connectionGeneration}`;
  const latestScope = useRef(scope); latestScope.current = scope;
  const fail = useMemoizedFn((cause: unknown) => {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    if (cause instanceof HttpError && cause.status === 401) onAuthExpired();
    setError(cause instanceof Error ? cause.message : "历史搜索暂不可用");
  });
  const invalidate = useMemoizedFn(() => {
    revision.current++; request.current?.abort(); setBusy(false); setOpening(undefined); setResult(undefined); setContext(undefined); setError("");
  });
  useEffect(() => {
    invalidate(); setProjects([]); setProject(""); setStatus(undefined);
    const controller = new AbortController();
    let alive = true;
    void listTerminalProjects(apiBase, token).then(items => {
      if (!alive || latestScope.current !== scope) return;
      setProjects(items); setProject(items.find(item => item.projectId === activeProject && item.path)?.projectId ?? items.find(item => !item.isDefault && item.path)?.projectId ?? "");
    }).catch(cause => { if (alive && latestScope.current === scope) fail(cause); });
    const poll = () => { void sessionSearchClient(apiBase, token, controller.signal).status().then(value => {
      if (alive && latestScope.current === scope) setStatus(value);
    }).catch(cause => { if (alive && latestScope.current === scope) fail(cause); }); };
    poll(); const timer = window.setInterval(poll, 3000);
    return () => { alive = false; controller.abort(); clearInterval(timer); request.current?.abort(); };
    // The selected project initializes once per computer; user selections remain local to this view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const change = useMemoizedFn((action: () => void) => { invalidate(); action(); });
  const search = useMemoizedFn(async (cursor?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++revision.current, computer = scope;
    setBusy(true); setOpening(undefined); setContext(undefined); setError("");
    if (!cursor) setResult(undefined);
    try {
      const value = await sessionSearchClient(apiBase, token, controller.signal).search({ query: query.trim(),
        ...(project === "all" ? { allProjects: true } : { projectId: project }),
        provider: provider === "all" ? undefined : provider as SessionSearchProvider, level, includeOtherOrigins: others, cursor });
      if (version !== revision.current || latestScope.current !== computer) return;
      setResult(previous => cursor && previous ? { ...value, hits: [...previous.hits, ...value.hits] } : value);
    } catch (cause) { if (version === revision.current && latestScope.current === computer) { setResult(undefined); fail(cause); } }
    finally { if (version === revision.current && latestScope.current === computer) setBusy(false); }
  });
  const open = useMemoizedFn(async (id: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++revision.current, computer = scope;
    setBusy(false); setOpening(id); setContext(undefined); setError("");
    try {
      const value = await sessionSearchClient(apiBase, token, controller.signal).context(id);
      if (version === revision.current && latestScope.current === computer) setContext(value);
    } catch (cause) { if (version === revision.current && latestScope.current === computer) fail(cause); }
    finally { if (version === revision.current && latestScope.current === computer) setOpening(undefined); }
  });
  const refresh = useMemoizedFn(async () => {
    invalidate(); const version = revision.current, computer = scope;
    setStatus(value => value ? { ...value, state: "indexing" } : value);
    try { const value = await sessionSearchClient(apiBase, token).refresh(); if (version === revision.current && latestScope.current === computer) setStatus(value); }
    catch (cause) { if (version === revision.current && latestScope.current === computer) fail(cause); }
  });
  return <section aria-label="会话搜索" className="flex h-full flex-col gap-5 overflow-auto p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-sm text-muted-foreground">从 Agent 原生记录找回对话与操作。</p></div>
      <Button variant="outline" onClick={() => void refresh()} disabled={status?.state === "indexing"}>更新索引</Button>
    </header>
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void search(); }}>
      <fieldset className="flex flex-wrap gap-4"><legend className="sr-only">搜索范围</legend>
        <Choice label="项目" value={project} onChange={value => change(() => setProject(value))} items={[...projects.filter(item => item.path).map(item => ({ id: item.projectId, label: item.name })), { id: "all", label: "全部项目（此电脑）" }]} />
        <Choice label="Agent" value={provider} onChange={value => change(() => setProvider(value))} items={[{ id: "all", label: "全部 Agent" }, ...["codex", "pi", "claude"].map(id => ({ id, label: id }))]} />
        <Choice label="内容" value={level} onChange={value => change(() => setLevel(value as SessionSearchLevel))} items={[...levels]} />
      </fieldset>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={others} onChange={event => change(() => setOthers(event.target.checked))} />包含后台任务、子 Agent 与审查记录</label>
      <div className="flex gap-2"><Input aria-label="搜索关键词" placeholder="关键词、文件名或错误码，例如 MermaidKit" value={query} onChange={event => change(() => setQuery(event.target.value))} maxLength={500} /><Button type="submit" disabled={busy || !query.trim() || !project}>{busy ? "搜索中…" : "搜索"}</Button></div>
    </form>
    <section aria-label="索引状态" className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>{status ? `${status.node} · ${status.state === "indexing" ? "索引中" : status.state === "ready" ? "索引就绪" : "尚未扫描"} · ${status.lastScanAt ? new Date(status.lastScanAt).toLocaleString() : "尚未完成扫描"}` : "正在连接索引…"}</p>
      {status?.sources.map(source => <details key={source.provider}><summary>{source.provider} · {source.sessions} 个会话 · {source.status === "ready" ? "可用" : source.status === "indexing" ? "索引中" : source.status === "unavailable" ? "来源不可用" : "部分覆盖"}</summary>{source.issues.map(issue => <p className="break-all" key={issue}>{issue}</p>)}</details>)}
    </section>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {result?.partial ? <p role="status" className="text-sm">本次结果覆盖不完整，请查看索引状态。重新搜索时会检查记录变化。</p> : null}
    {result && !result.hits.length ? <p role="status" className="text-sm text-muted-foreground">没有匹配的会话。可减少关键词，或扩大内容和项目范围。</p> : null}
    <div className="grid gap-5 xl:grid-cols-2">
      <section aria-label="搜索结果" className="flex flex-col gap-3">{result?.hits.map(hit => <article key={hit.id} className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="font-medium">{hit.title}</h2><p className="text-xs text-muted-foreground">{hit.provider} · {kindLabel[hit.kind]} · {hit.projectPath}</p>
        <p className="whitespace-pre-wrap break-words text-sm">{hit.text}</p>
        <Button variant="outline" onClick={() => void open(hit.id)} disabled={opening === hit.id}>{opening === hit.id ? "核对原文…" : "查看上下文"}</Button>
      </article>)}{result?.nextCursor ? <Button variant="outline" disabled={busy} onClick={() => void search(result.nextCursor!)}>更多会话</Button> : null}</section>
      <section aria-label="会话上下文" className="flex min-w-0 flex-col gap-3">{context ? <>
        <h2 className="font-medium">原生记录 · {context.sourceState === "verified" ? "已核对原文" : "原文已变化或缺失"}</h2>
        {context.partial ? <p className="text-sm text-muted-foreground">这是有长度限制的局部上下文，部分内容可能缺失。请勿当作完整执行证据。</p> : null}
        <h3 className="text-sm font-medium">命中记录</h3><RecordText hit={context.hit} />
        {context.paired.length ? <><h3 className="text-sm font-medium">同一调用的请求与结果</h3>{context.paired.map(hit => <RecordText key={hit.id} hit={hit} />)}</> : null}
        <details><summary className="cursor-pointer text-sm font-medium">前后记录</summary><div className="mt-3 flex flex-col gap-3">{context.records.filter(hit => hit.id !== context.hit.id).map(hit => <RecordText key={hit.id} hit={hit} />)}</div></details>
      </> : <p className="text-sm text-muted-foreground">选择结果，查看前后记录及明确配对的工具请求与结果。</p>}</section>
    </div>
  </section>;
}
