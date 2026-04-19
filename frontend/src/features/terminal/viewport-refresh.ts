const DEFAULT_VIEWPORT_REFRESH_DELAY_MS = 120;

interface ScheduleTerminalViewportRefreshOptions {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: (callback: () => void, delayMs: number) => number;
  clearTimeout?: (handle: number) => void;
  delayMs?: number;
}

export function scheduleTerminalViewportRefresh(
  refresh: () => void,
  options: ScheduleTerminalViewportRefreshOptions = {},
): () => void {
  const requestFrame =
    options.requestAnimationFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame =
    options.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window);
  const setTimer = options.setTimeout ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimeout ?? window.clearTimeout.bind(window);
  const delayMs = options.delayMs ?? DEFAULT_VIEWPORT_REFRESH_DELAY_MS;
  const frameIds: number[] = [];
  const timeoutIds: number[] = [];
  let cancelled = false;

  const runRefresh = () => {
    if (cancelled) {
      return;
    }
    refresh();
  };

  runRefresh();

  const firstFrameId = requestFrame(() => {
    runRefresh();
    const secondFrameId = requestFrame(runRefresh);
    frameIds.push(secondFrameId);
  });
  frameIds.push(firstFrameId);

  const timeoutId = setTimer(runRefresh, delayMs);
  timeoutIds.push(timeoutId);

  return () => {
    cancelled = true;
    for (const frameId of frameIds) {
      cancelFrame(frameId);
    }
    for (const timeoutId of timeoutIds) {
      clearTimer(timeoutId);
    }
  };
}
