// Runweave's private tmux server uses the default copy-mode wheel bindings (-N 5).
const TMUX_ROWS_PER_WHEEL = 5;
const GESTURE_IDLE_MS = 250;

type ScrollEvent = Pick<WheelEvent, "deltaY" | "deltaMode" | "timeStamp">;

/** One accumulator per terminal. Preserve distance instead of rounding every event up. */
export function createTmuxScrollInput() {
  let pendingPixels = 0;
  let lastEventAt = -Infinity;

  const reset = () => {
    pendingPixels = 0;
    lastEventAt = -Infinity;
  };

  return {
    reset,
    consume(
      event: ScrollEvent,
      cols: number,
      rows: number,
      lineHeight: number,
      sensitivity: number,
    ): { input: string; rows: number } | null {
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        reset();
        return null;
      }
      const unit =
        event.deltaMode === 1
          ? lineHeight
          : event.deltaMode === 2
            ? lineHeight * rows
            : 1;
      const pixels = event.deltaY * unit * sensitivity;
      if (!Number.isFinite(pixels) || pixels === 0) return null;
      if (
        event.timeStamp - lastEventAt > GESTURE_IDLE_MS ||
        Math.sign(pixels) !== Math.sign(pendingPixels)
      ) {
        pendingPixels = 0;
      }
      lastEventAt = event.timeStamp;
      pendingPixels += pixels;
      const pixelsPerWheel = lineHeight * TMUX_ROWS_PER_WHEEL;
      const wheels = Math.trunc(pendingPixels / pixelsPerWheel);
      if (wheels === 0) return null;
      pendingPixels -= wheels * pixelsPerWheel;

      const button = wheels < 0 ? 64 : 65;
      const col = Math.max(1, Math.floor(cols / 2));
      const row = Math.max(1, Math.floor(rows / 2));
      return {
        input: `\x1b[<${button};${col};${row}M`.repeat(Math.abs(wheels)),
        rows: wheels * TMUX_ROWS_PER_WHEEL,
      };
    },
  };
}
