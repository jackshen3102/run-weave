const SCROLL_LINES_PER_EVENT = 3;
const WHEEL_DELTA_PER_LINE = 40;

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
