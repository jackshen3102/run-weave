import type { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { WebSocketSessionController } from "./session-control";

function createSocketMock(): Pick<WebSocket, "close"> {
  return {
    close: vi.fn(),
  };
}

describe("WebSocketSessionController", () => {
  it("tracks connection counts per session", () => {
    const controller = new WebSocketSessionController();
    const firstSocket = createSocketMock();
    const secondSocket = createSocketMock();

    controller.register("session-1", firstSocket as WebSocket);
    controller.register("session-1", secondSocket as WebSocket);
    controller.register("session-2", createSocketMock() as WebSocket);

    expect(controller.getSessionConnectionCount("session-1")).toBe(2);
    expect(controller.getSessionConnectionCount("session-2")).toBe(1);
  });

  it("removes sockets from bookkeeping when unregistered", () => {
    const controller = new WebSocketSessionController();
    const socket = createSocketMock();

    controller.register("session-1", socket as WebSocket);
    controller.unregister("session-1", socket as WebSocket);

    expect(controller.getSessionConnectionCount("session-1")).toBe(0);
  });

  it("disconnects all sockets for an active session", () => {
    const controller = new WebSocketSessionController();
    const firstSocket = createSocketMock();
    const secondSocket = createSocketMock();

    controller.register("session-1", firstSocket as WebSocket);
    controller.register("session-1", secondSocket as WebSocket);

    expect(controller.disconnectSession("session-1")).toBe(true);
    expect(firstSocket.close).toHaveBeenCalledWith(1012, "Forced reconnect");
    expect(secondSocket.close).toHaveBeenCalledWith(1012, "Forced reconnect");
  });

  it("returns false when disconnecting a session without sockets", () => {
    const controller = new WebSocketSessionController();

    expect(controller.disconnectSession("missing")).toBe(false);
  });
});
