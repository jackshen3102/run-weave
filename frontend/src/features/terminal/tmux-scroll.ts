const SCROLL_LINES_PER_EVENT = 1;
const WHEEL_DELTA_PER_LINE = 80;

/**
 * Minimum interval (ms) between tmux scroll inputs.
 * Trackpads fire high-frequency wheel events; throttling prevents
 * multiple screens from flying past on a single swipe.
 */
const TMUX_SCROLL_THROTTLE_MS = 60;

let lastTmuxScrollAt = 0;

/**
 * Returns true when enough time has elapsed since the last accepted scroll.
 * Call this **before** `buildTmuxScrollInput` to drop excessive events.
 */
export function shouldThrottleTmuxScroll(): boolean {
  const now = performance.now();
  if (now - lastTmuxScrollAt < TMUX_SCROLL_THROTTLE_MS) {
    return true;
  }
  lastTmuxScrollAt = now;
  return false;
}

/**
 * Converts a wheel deltaY into SGR-encoded mouse scroll escape sequences
 * that tmux interprets when `mouse on` is active.
 *
 * SGR encoding: `\e[<button;col;rowM`
 *   - button 64 = scroll up
 *   - button 65 = scroll down
 */
export function buildTmuxScrollInput(
  deltaY: number,
  cols: number,
  rows: number,
): string | null {
  if (deltaY === 0) {
    return null;
  }

  const button = deltaY < 0 ? 64 : 65;
  const col = Math.max(1, Math.floor(cols / 2));
  const row = Math.max(1, Math.floor(rows / 2));
  const lines = Math.min(
    Math.max(1, Math.ceil(Math.abs(deltaY) / WHEEL_DELTA_PER_LINE)),
    SCROLL_LINES_PER_EVENT,
  );

  return `\x1b[<${button};${col};${row}M`.repeat(lines);
}
