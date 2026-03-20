import type { ClientInputMessage } from "@browser-viewer/shared";
import type { Page } from "playwright";
import { applyInputToPage } from "./input";

type PageInputMessage = Exclude<
  ClientInputMessage,
  Extract<ClientInputMessage, { type: "tab" | "navigation" }>
>;

export function handlePageInputMessage(params: {
  parsed: PageInputMessage;
  activePage: Page;
  sessionId: string;
  sendError: (message: string) => void;
  sendAck: () => void;
  scheduleCursorLookup: (x: number, y: number) => void;
}): void {
  const { parsed, activePage, sessionId, sendError, sendAck, scheduleCursorLookup } =
    params;

  void applyInputToPage(activePage, parsed)
    .then(() => {
      console.log("[viewer-be] input applied", {
        sessionId,
        eventType: parsed.type,
      });
      sendAck();
      if (parsed.type === "mouse" && parsed.action === "move") {
        scheduleCursorLookup(parsed.x, parsed.y);
      }
    })
    .catch((error) => {
      console.log("[viewer-be] input apply failed", {
        sessionId,
        eventType: parsed.type,
        error: String(error),
      });
      sendError(String(error));
    });
}
