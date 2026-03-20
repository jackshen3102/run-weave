import { describe, expect, it, vi } from "vitest";
import { handlePageInputMessage } from "./input-handler";
import * as inputModule from "./input";

describe("handlePageInputMessage", () => {
  it("acks and schedules cursor lookup for mouse move", async () => {
    vi.spyOn(inputModule, "applyInputToPage").mockResolvedValueOnce(undefined);
    const sendAck = vi.fn();
    const sendError = vi.fn();
    const scheduleCursorLookup = vi.fn();

    handlePageInputMessage({
      parsed: { type: "mouse", action: "move", x: 10, y: 20 },
      activePage: {} as never,
      sessionId: "s-1",
      sendAck,
      sendError,
      scheduleCursorLookup,
    });

    await Promise.resolve();
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendError).not.toHaveBeenCalled();
    expect(scheduleCursorLookup).toHaveBeenCalledWith(10, 20);
  });

  it("sends error when apply input fails", async () => {
    vi.spyOn(inputModule, "applyInputToPage").mockRejectedValueOnce(new Error("boom"));
    const sendAck = vi.fn();
    const sendError = vi.fn();

    handlePageInputMessage({
      parsed: { type: "keyboard", key: "A" },
      activePage: {} as never,
      sessionId: "s-1",
      sendAck,
      sendError,
      scheduleCursorLookup: vi.fn(),
    });

    await Promise.resolve();
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith("Error: boom");
  });
});
