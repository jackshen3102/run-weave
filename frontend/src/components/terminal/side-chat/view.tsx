import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { useSideChat } from "../../../features/side-chat/use-side-chat";
import { messageSequence, type SideChatModel } from "../../../features/side-chat/model";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { SideChatComposer } from "./composer";
import { SideChatContext } from "./context";
export function SideChatEntry({ terminalId, panelId }: { terminalId: string | null; panelId: string | null }) {
  const { model, state, open } = useSideChat(terminalId, panelId);
  if (!terminalId || !state.capabilities) return null;
  return <div className="flex items-center gap-2">
    {state.error && !model.navigation.visible ? <span role="alert" className="max-w-64 truncate text-xs text-destructive" title={state.error}>{state.error}</span> : null}
    <Button variant="ghost" size="sm" className="h-6 px-2" onClick={open} disabled={state.loading} title={state.capabilities.reason ?? "独立消息旁聊"} aria-label="打开消息旁聊"><MessageCircle data-icon="inline-start" />旁聊{state.unread ? " · 新回复" : ""}</Button>
  </div>;
}
const turnLabels: Record<string, string> = { accepted: "正在回答…", running: "正在回答…", stopping: "正在停止…", stopped: "已停止回答", failed: "回答失败，请重新提问", unknown: "执行结果不明，请查询状态或结束旁聊" };
export function SideChatView({ model, title, mainStatus }: { model: SideChatModel; title: string; mainStatus: string }) {
  const { snapshot, stale, error, pending } = model.state;
  const [context, setContext] = useState(false);
  const [ending, setEnding] = useState(false);
  const messages = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const sequence = messageSequence(snapshot?.messages ?? []);
  const lastMessageId = snapshot?.messages.at(-1)?.id;
  useEffect(() => { const list = messages.current; if (list && pinnedToBottom.current) list.scrollTop = list.scrollHeight; }, [lastMessageId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = messages.current;
      if (list && list.scrollHeight - list.clientHeight - list.scrollTop < 120) model.presented();
    });
    return () => cancelAnimationFrame(frame);
  }, [sequence, stale, model]);
  useEffect(() => { const list = messages.current; if (list) list.scrollTop = list.scrollHeight; }, [snapshot?.sideChat.id]);
  const turn = snapshot?.currentTurn;
  return <section aria-label="消息旁聊" className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background font-sans text-foreground">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
      <Button variant="ghost" size="sm" onClick={() => model.view(false)}>返回主对话</Button>
      <h2 className="truncate text-sm font-medium">旁聊 · {title}</h2>
      <Button variant="ghost" size="sm" disabled={!model.canEnd} onClick={() => setEnding(true)}>结束旁聊</Button>
    </header>
    {snapshot ? <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setContext(true)}>主对话 · {snapshot.sideChat.source.turnNumber ? `第 ${snapshot.sideChat.source.turnNumber} 轮` : "固定来源轮次"}</Button>
      <span>主任务：{mainStatus}</span>
    </div> : null}
    {stale ? <div role="status" className="flex shrink-0 items-center justify-between gap-2 px-4 py-2 text-sm text-destructive">连接中断或数据已过期<Button variant="outline" size="sm" onClick={() => { void model.refresh(); }}>刷新</Button></div> : null}
    {error ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
    {pending ? <div role="status" className="flex items-center gap-3 px-4 py-2 text-sm"><span>操作已提交，正在核对结果…</span><Button variant="outline" size="sm" onClick={() => { void model.reconcilePending(); }}>查询操作</Button></div> : null}
    <div ref={messages} role="log" aria-label="旁聊消息记录" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5" onScroll={() => { const list = messages.current; if (!list) return; pinnedToBottom.current = list.scrollHeight - list.clientHeight - list.scrollTop < 80; if (pinnedToBottom.current) model.presented(); }}>
      {snapshot?.beforeSequence ? <Button variant="ghost" size="sm" onClick={() => { void model.older(); }}>加载更早消息</Button> : null}
      {!snapshot?.messages.length ? <p className="m-auto text-center text-sm text-muted-foreground">在这里就当前任务独立提问。<br />返回后仍可继续。</p> : null}
      {snapshot?.messages.map(message => <article key={message.id} data-message-id={message.id} className={cn("flex min-w-0 flex-col gap-2", message.role === "user" ? "max-w-[80%] self-end" : "w-full self-stretch")}>
        <p className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", message.role === "user" ? "rounded-2xl bg-primary px-4 py-3 text-primary-foreground" : "text-foreground")}>{message.text}</p>
        {message.role === "user" && message.turnId !== turn?.id && ["stopped", "failed", "unknown"].includes(message.turnState ?? "") ? <span className="text-xs text-muted-foreground">{turnLabels[message.turnState!]}</span> : null}
      </article>)}
      {turn && turnLabels[turn.state] ? <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground"><span>{turnLabels[turn.state]}</span>{["accepted", "running"].includes(turn.state) ? <Button variant="outline" size="sm" disabled={stale || Boolean(pending)} onClick={() => { void model.stop(); }}>停止</Button> : null}</div> : null}
      {snapshot && ["ended", "unavailable", "ending"].includes(snapshot.sideChat.status) ? <p role="status" className="text-sm text-muted-foreground">{snapshot.sideChat.status === "ended" ? "旁聊已结束。记录和本机未发送文字仍可查看、复制。" : snapshot.sideChat.status === "ending" ? "正在结束旁聊…" : "旁聊分支不可用。已收消息和草稿已保留。"}</p> : null}
    </div>
    <SideChatComposer model={model} />
    {snapshot ? <SideChatContext source={snapshot.sideChat.source} open={context} onOpenChange={setContext} /> : null}
    <AlertDialog open={ending} onOpenChange={setEnding}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>结束这段旁聊？</AlertDialogTitle><AlertDialogDescription>当前回答会停止。结束后保留记录，下次进入会建立新的旁聊。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { void model.end(); }}>结束旁聊</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
