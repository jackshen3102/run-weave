import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { WebSocket } from "ws";
import type { ConnectionContext } from "./context";
import { createScreencastController } from "./screencast";

class FakeCdpSession extends EventEmitter {
  send = vi.fn(async () => undefined);
  detach = vi.fn(async () => undefined);
}

describe("createScreencastController", () => {
  it("starts and stops screencast", async () => {
    const cdp = new FakeCdpSession();
    const newCDPSession = vi.fn(async () => cdp);
    const context = { newCDPSession } as unknown as BrowserContext;
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
    const state = {
      cdpSession: null,
      activePage: {} as Page,
      activeTabId: "tab-1",
    } as unknown as ConnectionContext;

    const controller = createScreencastController({
      socket,
      state,
      context,
      sessionId: "s-1",
    } as never);

    await controller.start();
    expect(newCDPSession).toHaveBeenCalled();
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
