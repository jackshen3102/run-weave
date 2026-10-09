import type { RefObject } from "react";
import type { RichPasteController } from "../../../features/terminal/input/use-rich-paste";

export function RichPasteStatus({
  controller,
  purpose,
  textareaRef,
}: {
  controller: RichPasteController;
  purpose: "tui" | "composer";
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div
      className="pointer-events-auto flex max-h-48 w-full flex-col gap-1 overflow-auto"
      aria-label="图文粘贴状态"
    >
      {controller.items
        .filter((item) => item.purpose === purpose)
        .map((item) => (
          <div
            key={item.id}
            className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
          >
            <p role="status">{item.message}</p>
            {item.document?.images.map((image, index) =>
              image.error ? (
                <p key={index} className="text-amber-300">
                  图片 {index + 1}：{image.error}
                </p>
              ) : null,
            )}
            <div className="mt-1 flex gap-3">
              {item.status !== "pending" && item.status !== "inserted" ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void controller.run(item, textareaRef?.current)
                    }
                  >
                    重新插入图文
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void controller.run(item, textareaRef?.current, true)
                    }
                  >
                    仅粘贴文字
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        item.snapshot.plainText ||
                          item.document?.markdown(true) ||
                          "",
                      )
                    }
                  >
                    复制原文
                  </button>
                </>
              ) : null}
              <button type="button" onClick={() => controller.remove(item)}>
                {item.status === "pending" ? "取消" : "关闭"}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
