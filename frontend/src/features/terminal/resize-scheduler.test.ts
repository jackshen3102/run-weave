import { describe, expect, it, vi } from "vitest";
import { createResizeScheduler } from "./resize-scheduler";

describe("createResizeScheduler", () => {
  it("batches rapid resize requests into one callback", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const scheduler = createResizeScheduler(callback, 120);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    vi.advanceTimersByTime(119);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("cancels pending callbacks when disposed", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const scheduler = createResizeScheduler(callback, 120);

    scheduler.schedule();
    scheduler.dispose();
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
