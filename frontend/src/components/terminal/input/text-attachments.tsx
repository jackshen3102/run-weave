import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  TextAttachmentItem,
  TerminalTextAttachmentsController,
} from "../../../features/terminal/input/text-attachments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";

const labels = {
  pending: "正在保存…",
  saved: "已保存",
  inserted: "已插入",
  "not-inserted": "未插入",
  error: "保存失败",
  unknown: "交付未确认",
};
export function TerminalTextAttachments({
  controller,
  purpose,
  textareaRef,
  onDraftChange,
}: {
  controller: TerminalTextAttachmentsController;
  purpose: "tui" | "composer";
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onDraftChange?: (value: string) => void;
}) {
  const [preview, setPreview] = useState<{
    item: TextAttachmentItem;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const scopeRef = useRef(controller.scopeId);
  scopeRef.current = controller.scopeId;
  useEffect(() => {
    requestGeneration.current++;
    setPreview(null);
    setError(null);
  }, [controller.scopeId]);
  const items = controller.items.filter((item) => item.purpose === purpose);
  const open = async (item: TextAttachmentItem) => {
    const generation = ++requestGeneration.current;
    try {
      const text = await controller.read(item);
      if (generation === requestGeneration.current) {
        setPreview({ item, text });
        setError(null);
      }
    } catch (nextError) {
      setError(String(nextError));
    }
  };
  const restore = async (item: TextAttachmentItem) => {
    const textarea = textareaRef?.current;
    if (!textarea || !onDraftChange) return;
    const scope = scopeRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const previous = textarea.value;
    try {
      const text = await controller.read(item);
      if (
        scopeRef.current !== scope ||
        textareaRef?.current !== textarea ||
        textarea.value !== previous
      ) {
        setError("输入已变化，请重新选择恢复位置");
        return;
      }
      onDraftChange(previous.slice(0, start) + text + previous.slice(end));
      controller.remove(item);
      setPreview(null);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start + text.length, start + text.length);
      });
    } catch (nextError) {
      setError(String(nextError));
    }
  };
  return (
    <>
      {items.length > 0 ? (
        <div
          aria-label={purpose === "tui" ? "TUI 文本附件" : "文本附件"}
          className="pointer-events-auto max-h-40 w-full overflow-auto rounded-lg border border-slate-700 bg-slate-950/95 p-2 text-xs text-slate-200"
        >
          {items.map((item, index) => (
            <div
              key={item.key}
              data-text-attachment-status={item.status}
              className="mb-1 flex flex-wrap items-center gap-2"
            >
              <button
                type="button"
                onClick={() => void open(item)}
                className="rounded px-2 py-1 hover:bg-slate-800"
              >
                粘贴的文本{index ? ` (${index + 1})` : ""}.txt ·{" "}
                {item.text.length} 字符
              </button>
              <span role="status">{labels[item.status]}</span>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(item.text)
                    .catch((nextError) => setError(String(nextError)))
                }
              >
                复制原文
              </button>
              {purpose === "composer" ? (
                <button
                  type="button"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void restore(item)}
                >
                  放回输入框
                </button>
              ) : null}
              <button
                type="button"
                aria-label={purpose === "tui" ? "关闭附件提示" : "移除附件"}
                onClick={() => controller.remove(item)}
              >
                {purpose === "tui" ? "关闭" : "移除"}
              </button>
              {item.reason ? (
                <p role="alert" className="w-full text-amber-300">
                  {item.reason}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="pointer-events-auto bg-slate-950 p-2 text-xs text-amber-300"
        >
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(value) => {
          if (!value) {
            requestGeneration.current++;
            setPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl bg-slate-950 text-slate-200">
          <DialogTitle>粘贴的文本.txt</DialogTitle>
          <DialogDescription>{preview?.text.length} 字符</DialogDescription>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-xs">
            {preview?.text}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
