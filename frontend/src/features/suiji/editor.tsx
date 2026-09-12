import { useEffect, useSyncExternalStore } from "react";
import { useMemoizedFn } from "ahooks";
import type { SuijiRecord } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";
import type { SuijiEditorModel } from "./editor-model";

export function SuijiEditor({
  model,
  onClose,
  onSaved,
  onDiscard,
}: {
  model: SuijiEditorModel;
  onClose: () => void;
  onSaved: (record: SuijiRecord) => void;
  onDiscard: () => void;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot),
    { draft, busy } = state;
  const saved = useMemoizedFn(onSaved);
  const discarded = useMemoizedFn(onDiscard);
  useEffect(() => {
    if (state.saved) saved(state.saved);
  }, [state.saved, saved]);
  useEffect(() => { if (state.discarded) discarded(); }, [state.discarded, discarded]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="suiji-theme max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogTitle>
          {draft.id === "new" ? "记下一点什么" : "编辑记录"}
        </DialogTitle>
        <DialogDescription>
          {draft.frozen
            ? "保存结果待确认，请手动重试"
            : "文字与附件保存在本机草稿中，点保存后才会上传。"}
        </DialogDescription>
        <fieldset
          disabled={busy || draft.frozen}
          className="flex flex-col gap-4"
        >
          <div className="flex items-center gap-3">
            <span>类型</span>
            <div
              role="group"
              aria-label="记录类型"
              className="inline-flex gap-1 rounded-xl bg-secondary p-1"
            >
              {(
                [
                  ["note", "想法"],
                  ["task", "待办"],
                ] as const
              ).map(([kind, label]) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={draft.kind === kind ? "default" : "ghost"}
                  aria-pressed={draft.kind === kind}
                  onClick={() => model.edit({ kind })}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {draft.id !== "new" ? (
            <p className="text-sm text-muted-foreground">
              切换为待办时设为未完成；切换为想法时清除待办状态。
            </p>
          ) : null}
          <label className="flex flex-col gap-2">
            原文
            <textarea
              aria-label="原文"
              value={draft.body}
              onChange={(e) => model.edit({ body: e.target.value })}
              placeholder="此刻的想法、一个链接，或者以后想做的事……"
              className="min-h-56 resize-y rounded-xl border bg-background p-4 leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <span className="text-right text-xs text-muted-foreground">
            {[...draft.body].length.toLocaleString()} / 20,000
          </span>
          <label className="flex flex-col gap-2 text-sm">
            添加图片或 Markdown
            <input
              aria-label="添加附件"
              type="file"
              accept="image/jpeg,image/png,.md"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void model.addFile(file);
              }}
            />
          </label>
          {[
            ...draft.existing.map((a) => ({
              id: a.id,
              name: a.fileName,
              existing: true,
            })),
            ...draft.files.map((a) => ({
              id: a.id,
              name: a.file.name,
              existing: false,
            })),
          ].map((file) => (
            <div
              key={file.id}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <span className="truncate">{file.name}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  model.edit(
                    file.existing
                      ? {
                          existing: draft.existing.filter(
                            (a) => a.id !== file.id,
                          ),
                        }
                      : { files: draft.files.filter((a) => a.id !== file.id) },
                  )
                }
              >
                移除
              </Button>
            </div>
          ))}
        </fieldset>
        {state.message ? (
          <p
            role="alert"
            className="whitespace-pre-wrap text-sm text-destructive"
          >
            {state.message}
          </p>
        ) : null}
        {state.conflict ? (
          <Button variant="outline" onClick={() => void model.loadLatest()}>
            查看最新原文
          </Button>
        ) : null}
        {state.latest ? (
          <section className="flex flex-col gap-3 rounded-xl border p-4">
            <p className="text-sm text-muted-foreground">
              服务端版本 {state.latest.version}，类型：
              {state.latest.kind === "note" ? "想法" : "待办"}
              。请与上方本机草稿比较
            </p>
            <p className="whitespace-pre-wrap break-words">
              {state.latest.body}
            </p>
            <Button
              variant="outline"
              onClick={() => model.acceptLatestVersion()}
            >
              保留本机正文和类型，采用最新版本继续编辑
            </Button>
          </section>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span role="status" className="text-xs text-muted-foreground">
            {state.localError
              ? "本机草稿未保存"
              : state.localSaving
                ? "正在保存本机草稿…"
                : "本机草稿已保存"}
          </span>
          <Button disabled={busy} onClick={() => void model.save()}>
            {busy ? "正在保存…" : draft.frozen ? "手动重试确认" : "保存"}
          </Button>
        </div>
      <Button variant="ghost" disabled={busy || draft.frozen} onClick={() => { if (window.confirm("放弃这份本机草稿？已保存的记录不会改变。")) void model.discard(); }}>放弃本机草稿</Button>
      </DialogContent>
    </Dialog>
  );
}
