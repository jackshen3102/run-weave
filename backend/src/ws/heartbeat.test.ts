import { describe, expect, it, vi } from "vitest";
import { createHeartbeatController } from "./heartbeat";

describe("createHeartbeatController", () => {
  it("starts heartbeat and pings when alive", () => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: 1,
        ping: vi.fn(),
        terminate: vi.fn(),
      } as never;
      const state = {
        heartbeatTimer: null,
        isAlive: true,
      } as never;

      const controller = createHeartbeatController(socket, state);
      controller.start();
      vi.advanceTimersByTime(15_000);

      expect(socket.ping).toHaveBeenCalledTimes(1);
      expect(socket.terminate).not.toHaveBeenCalled();

      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates when pong was not received", () => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: 1,
        ping: vi.fn(),
        terminate: vi.fn(),
      } as never;
      const state = {
        heartbeatTimer: null,
        isAlive: true,
      } as never;

      const controller = createHeartbeatController(socket, state);
      controller.start();
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(15_000);

      expect(socket.terminate).toHaveBeenCalledTimes(1);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
