import type { SideChatSourceSnapshot } from "@runweave/shared/side-chat";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
export function SideChatContext({ source, open, onOpenChange }: { source: SideChatSourceSnapshot; open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[80vh] overflow-y-auto">
    <DialogHeader><DialogTitle>来源上下文</DialogTitle><DialogDescription>创建时固定的来源轮次文字预览；主任务后续内容不会自动加入。</DialogDescription></DialogHeader>
    <p className="break-all text-xs text-muted-foreground">轮次 {source.lastCompletedTurnId}<br />{source.model} · {source.cwd}</p>
    {source.preview.map((message, index) => <section key={index} className="flex flex-col gap-2"><strong className="text-sm">{message.role === "user" ? "用户" : "助手"}</strong><p className="whitespace-pre-wrap break-words text-sm">{message.text}</p></section>)}
  </DialogContent></Dialog>;
}
