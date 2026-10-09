import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalPastePreparation } from "@runweave/shared/terminal/text-attachments";
import {
  createTerminalSessionClipboardImage,
  terminalTextAttachmentRequest,
} from "../../../services/terminal/sessions";
import {
  parseRichPaste,
  prepareRichImages,
  snapshotRichPaste,
  type RichPasteDocument,
  type RichPasteSnapshot,
} from "./rich-paste";

type Purpose = "tui" | "composer";
export interface RichPasteItem {
  id: string;
  purpose: Purpose;
  snapshot: RichPasteSnapshot;
  document?: RichPasteDocument;
  status: "pending" | "ready" | "error" | "inserted";
  message: string;
  cache: Map<string, { path: string; bytes: number }>;
  attempt: number;
}
const records = new Map<string, RichPasteItem[]>();

export function useRichPaste(options: {
  apiBase: string;
  token: string;
  sessionId: string;
  panelId: string;
  threadId: string | null;
  active: boolean;
  sending: boolean;
  captureText: (
    text: string,
    purpose: Purpose,
    preparationId?: string,
  ) => boolean;
  onDraftChange: (text: string) => void;
}) {
  const key = JSON.stringify([
    options.apiBase,
    options.sessionId,
    options.panelId,
  ]);
  const current = useRef(options);
  current.current = options;
  const generation = useRef(0);
  const context = JSON.stringify([
    key,
    options.token,
    options.threadId,
    options.active,
  ]);
  const previous = useRef(context);
  if (previous.current !== context) {
    previous.current = context;
    generation.current++;
  }
  const [, render] = useState(0);
  const update = useMemoizedFn(() => render((value) => value + 1));
  const markInput = useMemoizedFn(() => {
    generation.current++;
  });
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (
        [...records.values()].flat().some((item) => item.status !== "inserted")
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const run = useMemoizedFn(
    async (
      item: RichPasteItem,
      textarea?: HTMLTextAreaElement | null,
      textOnly = false,
    ) => {
      if (current.current.sending || !current.current.active) return;
      const bound = { ...current.current };
      const boundContext = previous.current;
      const start = ++generation.current;
      const attempt = ++item.attempt;
      const selection = textarea
        ? {
            value: textarea.value,
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
          }
        : null;
      const present = () =>
        (records.get(key) ?? []).includes(item) && item.attempt === attempt;
      const targetCurrent = () =>
        present() &&
        previous.current === boundContext &&
        generation.current === start &&
        current.current.active;
      const inputCurrent = () =>
        targetCurrent() &&
        (!selection ||
          Boolean(
            textarea?.isConnected &&
            textarea.value === selection.value &&
            textarea.selectionStart === selection.start &&
            textarea.selectionEnd === selection.end,
          ));
      item.status = "pending";
      item.message = "正在准备图文…";
      update();
      try {
        if (item.purpose === "composer" && !textarea)
          throw new Error("请打开 Input 后重新插入");
        if (!bound.panelId) throw new Error("终端目标尚未就绪，内容已保留");
        const preparation =
          item.purpose === "tui"
            ? await terminalTextAttachmentRequest<TerminalPastePreparation>(
                bound.apiBase,
                bound.token,
                bound.sessionId,
                "/prepare",
                "POST",
                { panelId: bound.panelId },
              )
            : undefined;
        if (!item.document && !textOnly)
          item.document = parseRichPaste(item.snapshot);
        if (!textOnly && item.document)
          await prepareRichImages(
            item.document,
            item.cache,
            async (mimeType, dataBase64) => {
              const result = await createTerminalSessionClipboardImage(
                bound.apiBase,
                bound.token,
                bound.sessionId,
                { mimeType, dataBase64 },
                AbortSignal.timeout(20_000),
              );
              return result.filePath;
            },
            present,
          );
        if (!present()) return;
        const text = textOnly
          ? item.snapshot.plainText || item.document?.markdown(true) || ""
          : item.document!.markdown();
        if (!text) throw new Error("剪贴板没有可插入的文字或图片");
        if (!inputCurrent()) {
          item.status = "ready";
          item.message = "目标或输入已变化，内容已保留；可重新插入";
          update();
          return;
        }
        if (item.purpose === "tui") {
          if (
            !current.current.captureText(
              text,
              "tui",
              preparation!.preparationId,
            )
          )
            throw new Error("终端目标不可用，内容已保留");
          item.message = "图文已准备，投递结果见终端附件提示";
        } else if (current.current.captureText(text, "composer")) {
          item.message = "已添加为长文本附件";
        } else if (textarea && selection) {
          const draft =
            selection.value.slice(0, selection.start) +
            text +
            selection.value.slice(selection.end);
          current.current.onDraftChange(draft);
          const cursor = selection.start + text.length;
          requestAnimationFrame(() => {
            if (textarea.isConnected && textarea.value === draft) {
              textarea.focus();
              textarea.setSelectionRange(cursor, cursor);
            }
          });
          item.message = `已插入图文${item.document?.images.length ? `（${item.document.images.length} 张图片）` : ""}`;
        }
        item.status = "inserted";
        update();
      } catch (error) {
        if (!present()) return;
        item.status = "error";
        item.message =
          error instanceof Error ? error.message : "图文准备失败，内容已保留";
        update();
      }
    },
  );

  const capture = useMemoizedFn(
    (
      event: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>,
      purpose: Purpose,
    ) => {
      if (!event.clipboardData) return false;
      const snapshot = snapshotRichPaste(event.clipboardData);
      if (!snapshot) return false;
      event.preventDefault();
      event.stopPropagation();
      if ("nativeEvent" in event) event.nativeEvent.stopImmediatePropagation();
      else event.stopImmediatePropagation();
      const item: RichPasteItem = {
        id: crypto.randomUUID(),
        purpose,
        snapshot,
        status: "ready",
        message: "",
        cache: new Map(),
        attempt: 0,
      };
      const list = records.get(key) ?? [];
      // Successful notices need not retain clipboard bytes indefinitely.
      records.set(key, [
        ...list.filter((entry) => entry.status !== "inserted"),
        item,
      ]);
      if (current.current.sending) {
        item.status = "error";
        item.message = "正在发送，图文已保留";
        update();
        return true;
      }
      const textarea =
        purpose === "composer"
          ? (event.currentTarget as HTMLTextAreaElement)
          : null;
      void run(item, textarea);
      return true;
    },
  );
  const remove = useMemoizedFn((item: RichPasteItem) => {
    item.attempt++;
    records.set(
      key,
      (records.get(key) ?? []).filter((entry) => entry !== item),
    );
    update();
  });
  const items = records.get(key) ?? [];
  return {
    items,
    capture,
    run,
    remove,
    markInput,
    blocked: items.some(
      (item) => item.purpose === "composer" && item.status !== "inserted",
    ),
  };
}
export type RichPasteController = ReturnType<typeof useRichPaste>;
