import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createScreencastController } from "./screencast";

class FakeCdpSession extends EventEmitter {
  send = vi.fn(async () => undefined);
  detach = vi.fn(async () => undefined);
}

describe("createScreencastController", () => {
  it("starts and stops screencast", async () => {
    const cdp = new FakeCdpSession();
    const state = { cdpSession: null, activePage: {}, activeTabId: "tab-1" } as never;
    const context = { newCDPSession: vi.fn(async () => cdp) } as never;
    const socket = { readyState: 1, send: vi.fn() } as never;

    const controller = createScreencastController({
      socket,
      state,
      context,
      sessionId: "s-1",
    });

    await controller.start();
    expect(context.newCDPSession).toHaveBeenCalled();
    expect(cdp.send).toHaveBeenCalledWith("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 720,
    });

    await controller.stop();
    expect(cdp.send).toHaveBeenCalledWith("Page.stopScreencast");
    expect(cdp.detach).toHaveBeenCalled();
  });
});
