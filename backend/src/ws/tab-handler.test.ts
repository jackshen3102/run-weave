import { describe, expect, it, vi } from "vitest";
import { handleTabMessage } from "./tab-handler";

describe("handleTabMessage", () => {
  it("acks when tab switch succeeds", async () => {
    const sendAck = vi.fn();
    const sendError = vi.fn();

    handleTabMessage({
      parsed: { type: "tab", action: "switch", tabId: "tab-1" },
      createTab: vi.fn(async () => undefined),
      selectTab: vi.fn(async () => true),
      sendAck,
      sendError,
    });

    await Promise.resolve();
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendError).not.toHaveBeenCalled();
  });

  it("sends unknown-tab error when tab switch fails", async () => {
    const sendAck = vi.fn();
    const sendError = vi.fn();

    handleTabMessage({
      parsed: { type: "tab", action: "switch", tabId: "tab-404" },
      createTab: vi.fn(async () => undefined),
      selectTab: vi.fn(async () => false),
      sendAck,
      sendError,
    });

    await Promise.resolve();
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith("Unknown tabId: tab-404");
  });

  it("acks when creating a new tab succeeds", async () => {
    const sendAck = vi.fn();
    const sendError = vi.fn();

    handleTabMessage({
      parsed: { type: "tab", action: "create" },
      createTab: vi.fn(async () => undefined),
      selectTab: vi.fn(async () => true),
      sendAck,
      sendError,
    });

    await Promise.resolve();
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendError).not.toHaveBeenCalled();
  });
});
