// Legacy wheel moves five rows; negotiated Ctrl-wheel bindings move one row.
const TMUX_SCROLL_SPEED_MULTIPLIER = 2;
const GESTURE_IDLE_MS = 250;

type ScrollEvent = Pick<WheelEvent, "deltaY" | "deltaMode" | "timeStamp">;

/** One accumulator per terminal. Preserve distance instead of rounding every event up. */
export function createTmuxScrollInput(singleRow = false) {
  const rowsPerWheel = singleRow ? 1 : 5;
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
      const pixels =
        event.deltaY * unit * sensitivity * TMUX_SCROLL_SPEED_MULTIPLIER;
      if (!Number.isFinite(pixels) || pixels === 0) return null;
      if (
        event.timeStamp - lastEventAt > GESTURE_IDLE_MS ||
        Math.sign(pixels) !== Math.sign(pendingPixels)
      ) {
        pendingPixels = 0;
      }
      lastEventAt = event.timeStamp;
      pendingPixels += pixels;
      const pixelsPerWheel = lineHeight * rowsPerWheel;
      const wheels = Math.trunc(pendingPixels / pixelsPerWheel);
      if (wheels === 0) return null;
      pendingPixels -= wheels * pixelsPerWheel;

      // The negotiated private tmux bindings use Ctrl-wheel for single rows.
      const button = (wheels < 0 ? 64 : 65) + (singleRow ? 16 : 0);
      const col = Math.max(1, Math.floor(cols / 2));
      const row = Math.max(1, Math.floor(rows / 2));
      return {
        input: `\x1b[<${button};${col};${row}M`.repeat(Math.abs(wheels)),
        rows: wheels * rowsPerWheel,
      };
    },
  };
}

/** Preserve the order and distance of wheel input, sending at most once per frame. */
export function createTmuxScrollBatcher(send: (input: string) => void) {
  let pending = "";
  let frame: number | null = null;
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const flush = () => {
    cancelFrame();
    const input = pending;
    pending = "";
    if (input) send(input);
  };
  return {
    enqueue(input: string) {
      pending += input;
      if (frame === null) frame = requestAnimationFrame(flush);
    },
    flush,
    reset() {
      cancelFrame();
      pending = "";
    },
  };
}
