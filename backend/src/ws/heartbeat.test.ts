import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ConnectionContext } from "./context";
import { createHeartbeatController } from "./heartbeat";

describe("createHeartbeatController", () => {
  it("starts heartbeat and pings when alive", () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn();
      const terminate = vi.fn();
      const socket = { readyState: 1, ping, terminate } as unknown as WebSocket;
      const state = {
        heartbeatTimer: null,
        isAlive: true,
      } as unknown as ConnectionContext;

      const controller = createHeartbeatController(socket as never, state as never);
      controller.start();
      vi.advanceTimersByTime(15_000);

      expect(ping).toHaveBeenCalledTimes(1);
      expect(terminate).not.toHaveBeenCalled();

      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates when pong was not received", () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn();
      const terminate = vi.fn();
      const socket = { readyState: 1, ping, terminate } as unknown as WebSocket;
      const state = {
        heartbeatTimer: null,
        isAlive: true,
      } as unknown as ConnectionContext;

      const controller = createHeartbeatController(socket as never, state as never);
      controller.start();
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(15_000);

      expect(terminate).toHaveBeenCalledTimes(1);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
