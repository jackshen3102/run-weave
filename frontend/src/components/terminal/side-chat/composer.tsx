import { useEffect, useRef } from "react";
import { useMemoizedFn } from "ahooks";
import type { SideChatModel } from "../../../features/side-chat/model";
import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
export function SideChatComposer({ model }: { model: SideChatModel }) {
  const { draft, snapshot, pending, stale, composing } = model.state;
  const input = useRef<HTMLTextAreaElement>(null);
  const compositionEndedAt = useRef(0);
  const chatId = snapshot?.sideChat.id;
  useEffect(() => {
    const editor = input.current; if (!editor) return;
    editor.focus(); editor.setSelectionRange(model.state.draft.start, model.state.draft.end);
  }, [chatId, model]);
  const change = useMemoizedFn(() => { const editor = input.current; if (editor) model.setDraft(editor.value, editor.selectionStart, editor.selectionEnd); });
  return <form className="flex shrink-0 flex-col gap-2 border-t border-border p-4" onSubmit={event => { event.preventDefault(); void model.send(); }}>
    <Label htmlFor={`side-chat-${chatId}`}>旁聊消息</Label>
    <textarea ref={input} id={`side-chat-${chatId}`} aria-label="旁聊消息" rows={3}
      className="max-h-48 min-h-20 w-full resize-y rounded-md border border-input bg-background p-3 font-sans text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      readOnly={pending?.kind === "end"} value={draft.text} onChange={change} onSelect={change} onBlur={change}
      onCompositionStart={() => model.composition(true)} onCompositionEnd={() => { change(); compositionEndedAt.current = Date.now(); model.composition(false); }}
      placeholder="就当前任务独立提问…" onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing && event.nativeEvent.keyCode !== 229 && Date.now() - compositionEndedAt.current > 300) { event.preventDefault(); void model.send(); }
      }} />
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">独立问答 · 只展示最终答案</span>
      <Button type="submit" size="sm" disabled={!draft.text.trim() || model.busy || Boolean(pending) || stale || composing || snapshot?.sideChat.status !== "active"}>发送</Button>
    </div>
  </form>;
}
