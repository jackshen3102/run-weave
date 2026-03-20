import { describe, expect, it, vi } from "vitest";
import { handlePageInputMessage } from "./input-handler";
import * as inputModule from "./input";
import * as clipboardModule from "./clipboard";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("handlePageInputMessage", () => {
  it("acks and schedules cursor lookup for mouse move", async () => {
    vi.spyOn(inputModule, "applyInputToPage").mockResolvedValueOnce(undefined);
    const sendAck = vi.fn();
    const sendError = vi.fn();
    const scheduleCursorLookup = vi.fn();
    const sendClipboardCopy = vi.fn();

    handlePageInputMessage({
      parsed: { type: "mouse", action: "move", x: 10, y: 20 },
      activePage: {} as never,
      sessionId: "s-1",
      sendAck,
      sendError,
      sendClipboardCopy,
      scheduleCursorLookup,
    });

    await flushMicrotasks();
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendError).not.toHaveBeenCalled();
    expect(sendClipboardCopy).not.toHaveBeenCalled();
    expect(scheduleCursorLookup).toHaveBeenCalledWith(10, 20);
  });

  it("sends error when apply input fails", async () => {
    vi.spyOn(inputModule, "applyInputToPage").mockRejectedValueOnce(
      new Error("boom"),
    );
    const sendAck = vi.fn();
    const sendError = vi.fn();
    const sendClipboardCopy = vi.fn();

    handlePageInputMessage({
      parsed: { type: "keyboard", key: "A" },
      activePage: {} as never,
      sessionId: "s-1",
      sendAck,
      sendError,
      sendClipboardCopy,
      scheduleCursorLookup: vi.fn(),
    });

    await flushMicrotasks();
    expect(sendError).toHaveBeenCalledWith("Error: boom");
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendClipboardCopy).not.toHaveBeenCalled();
  });

  it("syncs clipboard text when handling copy shortcut", async () => {
    vi.spyOn(inputModule, "applyInputToPage").mockResolvedValueOnce(undefined);
    vi.spyOn(
      clipboardModule,
      "getClipboardCopyTextBeforeInput",
    ).mockResolvedValueOnce("copied text");
    const sendAck = vi.fn();
    const sendError = vi.fn();
    const sendClipboardCopy = vi.fn();

    handlePageInputMessage({
      parsed: { type: "keyboard", key: "c", modifiers: ["Control"] },
      activePage: {} as never,
      sessionId: "s-1",
      sendAck,
      sendError,
      sendClipboardCopy,
      scheduleCursorLookup: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(sendAck).toHaveBeenCalledTimes(1);
    });
    expect(sendError).not.toHaveBeenCalled();
    expect(sendClipboardCopy).toHaveBeenCalledWith("copied text");
  });
});
