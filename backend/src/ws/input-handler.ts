import type { ClientInputMessage } from "@browser-viewer/shared";
import type { Page } from "playwright";
import { logger } from "../logging";
import { applyInputToPage } from "./input";
import { getClipboardCopyTextBeforeInput } from "./clipboard";

const viewerWsLogger = logger.child({ component: "viewer-ws" });

type PageInputMessage = Exclude<
  ClientInputMessage,
  Extract<ClientInputMessage, { type: "tab" | "navigation" | "devtools" }>
>;

export function handlePageInputMessage(params: {
  parsed: PageInputMessage;
  activePage: Page;
  sessionId: string;
  sendError: (message: string) => void;
  sendAck: () => void;
  sendClipboardCopy: (text: string) => void;
  scheduleCursorLookup: (x: number, y: number) => void;
}): void {
  const {
    parsed,
    activePage,
    sessionId,
    sendError,
    sendAck,
    sendClipboardCopy,
    scheduleCursorLookup,
  } = params;

  void getClipboardCopyTextBeforeInput(activePage, parsed)
    .catch(() => null)
    .then((clipboardText) =>
      applyInputToPage(activePage, parsed).then(() => clipboardText),
    )
    .then((clipboardText) => {
      sendAck();
      if (clipboardText) {
        sendClipboardCopy(clipboardText);
      }
      if (parsed.type === "mouse" && parsed.action === "move") {
        scheduleCursorLookup(parsed.x, parsed.y);
      }
    })
    .catch((error) => {
      viewerWsLogger.error("viewer-ws.input.apply.failed", {
        message: "Viewer websocket input apply failed",
        sessionId,
        eventType: parsed.type,
        error,
      });
      sendError(String(error));
    });
}
