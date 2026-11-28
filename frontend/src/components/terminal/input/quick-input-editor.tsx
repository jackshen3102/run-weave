import { useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  TerminalQuickInputBackgroundRuntime,
  TerminalQuickInputItem,
} from "@runweave/shared/terminal/input";
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
  const [backgroundRuntime, setBackgroundRuntime] =
    useState<TerminalQuickInputBackgroundRuntime>(
      item?.backgroundRuntime === "terminal" ? "terminal" : "headless",
    );
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
        backgroundRuntime,
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
        className="max-h-[85dvh] overflow-y-auto"
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
            className="min-h-32 w-full rounded-md border bg-background p-3 text-sm sm:min-h-48"
            value={data}
            onChange={(event) => setData(event.target.value)}
            disabled={saving}
          />
        </label>
        <div
          className="space-y-2 text-sm"
          role="radiogroup"
          aria-label="后台运行方式"
        >
          <span>后台运行方式</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  value: "headless",
                  label: "纯后台运行",
                  desc: "静默调用后台 CLI，不创建终端",
                },
                {
                  value: "terminal",
                  label: "临时终端运行",
                  desc: "新开专用终端，完成即关、受阻保留",
                },
              ] as const
            ).map((option) => {
              const selected = backgroundRuntime === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={saving}
                  data-testid={`quick-input-runtime-${option.value}`}
                  onClick={() => setBackgroundRuntime(option.value)}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    selected
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-border bg-background hover:bg-accent/50"
                  }`}
                >
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
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
