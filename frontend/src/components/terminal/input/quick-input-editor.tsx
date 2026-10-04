import { useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalQuickInputItem } from "@runweave/shared/terminal/input";
import {
  createTerminalQuickInput,
  updateTerminalQuickInput,
} from "../../../services/terminal";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { buildQuickInputTitle } from "./quick-input-row";

export function QuickInputEditor({
  item,
  apiBase,
  token,
  connectionName,
  onClose,
  onSaved,
}: {
  item: TerminalQuickInputItem | null;
  apiBase: string;
  token: string;
  connectionName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [data, setData] = useState(item?.data ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMemoizedFn(async () => {
    if (saving || !data.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        title: title.trim() || buildQuickInputTitle(data),
        data,
      };
      if (item)
        await updateTerminalQuickInput(apiBase, token, item.id, {
          ...payload,
          expectedUpdatedAt: item.updatedAt,
        });
      else
        await createTerminalQuickInput(apiBase, token, {
          ...payload,
          mode: "line",
          projectId: null,
        });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{item ? "查看全文 / 编辑" : "新增指令"}</DialogTitle>
          <DialogDescription>{connectionName} · 全局快捷指令</DialogDescription>
        </DialogHeader>
        <label className="space-y-2 text-sm">
          标题
          <Input
            maxLength={80}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="可选"
            disabled={saving}
          />
        </label>
        <label className="space-y-2 text-sm">
          内容
          <textarea
            className="min-h-48 w-full rounded-md border bg-background p-3 text-sm"
            value={data}
            onChange={(event) => setData(event.target.value)}
            disabled={saving}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              saving ||
              !data.trim() ||
              new TextEncoder().encode(data).length > 65536
            }
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
