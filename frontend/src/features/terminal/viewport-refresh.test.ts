import { describe, expect, it, vi } from "vitest";
import { scheduleTerminalViewportRefresh } from "./viewport-refresh";

describe("scheduleTerminalViewportRefresh", () => {
  it("refreshes immediately, across animation frames, and with a delayed fallback", () => {
    const refresh = vi.fn();
    const frameCallbacks: FrameRequestCallback[] = [];
    const timeoutCallbacks: Array<() => void> = [];
    const cancelAnimationFrame = vi.fn();
    const clearTimeout = vi.fn();

    scheduleTerminalViewportRefresh(refresh, {
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame,
      setTimeout: (callback) => {
        timeoutCallbacks.push(callback);
        return timeoutCallbacks.length;
      },
      clearTimeout,
      delayMs: 120,
    });

    expect(refresh).toHaveBeenCalledTimes(1);

    frameCallbacks.shift()?.(performance.now());
    expect(refresh).toHaveBeenCalledTimes(2);

    frameCallbacks.shift()?.(performance.now());
    expect(refresh).toHaveBeenCalledTimes(3);

    timeoutCallbacks.shift()?.();
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("cancels pending frame and timeout refreshes", () => {
    const refresh = vi.fn();
    const frameCallbacks: FrameRequestCallback[] = [];
    const timeoutCallbacks: Array<() => void> = [];
    const cancelAnimationFrame = vi.fn();
    const clearTimeout = vi.fn();

    const cancel = scheduleTerminalViewportRefresh(refresh, {
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame,
      setTimeout: (callback) => {
        timeoutCallbacks.push(callback);
        return timeoutCallbacks.length;
      },
      clearTimeout,
      delayMs: 120,
    });

    cancel();
    frameCallbacks.shift()?.(performance.now());
    timeoutCallbacks.shift()?.();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(clearTimeout).toHaveBeenCalledWith(1);
  });
});
