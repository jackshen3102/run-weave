// Legacy wheel moves five rows; negotiated Ctrl-wheel bindings move one row.
const TMUX_SCROLL_SPEED_MULTIPLIER = 2;
const GESTURE_IDLE_MS = 250;

import type { TerminalScrollInput, TerminalScrollStop, TerminalScrollState } from "@runweave/shared/terminal/websocket";

/** One acknowledged batch in flight; preserve direction changes and fractional movement. */
export function createNormalizedScrollInput(send: (input: TerminalScrollInput | TerminalScrollStop) => void) {
  let remainder = 0;
  let lastAt = -Infinity;
  const gesturePrefix = Math.random().toString(36).slice(2);
  let gestureNumber = 0;
  let gestureId = "";
  let sequence = 0;
  let cancelled = false;
  let frame: number | null = null;
  let inFlight: TerminalScrollInput | null = null;
  const pending: number[] = [];
  const flush = () => {
    frame = null;
    if (inFlight || !pending.length || cancelled) return;
    const deltaSteps = Math.sign(pending[0]!) * Math.min(128, Math.abs(pending[0]!));
    pending[0] = pending[0]! - deltaSteps;
    if (!pending[0]) pending.shift();
    inFlight = { type: "scroll", gestureId, sequence: ++sequence, deltaSteps, phase: "direct" };
    send(inFlight);
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(flush); };
  const reset = () => {
    if (gestureId) send({ type: "scroll-stop", gestureId });
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; inFlight = null; pending.length = 0; remainder = 0; lastAt = -Infinity; cancelled = false;
  };
  return {
    reset,
    consume(event: ScrollEvent, lineHeight: number, rows: number) {
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      if (event.timeStamp - lastAt > GESTURE_IDLE_MS) {
        reset();
        gestureId = `scroll-${gesturePrefix}-${++gestureNumber}`;
      }
      lastAt = event.timeStamp;
      if (cancelled) return;
      const unit = event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? rows : 1 / lineHeight;
      const steps = -event.deltaY * unit;
      if (!Number.isFinite(steps)) return;
      if (Math.sign(steps) !== Math.sign(remainder)) remainder = 0;
      remainder += steps;
      const whole = Math.trunc(remainder);
      if (!whole) return;
      remainder -= whole;
      if (Math.sign(pending.at(-1) ?? 0) === Math.sign(whole)) pending[pending.length - 1] = pending[pending.length - 1]! + whole;
      else pending.push(whole);
      if (pending.reduce((sum, n) => sum + Math.abs(n), 0) > 512) { pending.length = 0; cancelled = true; }
      schedule();
    },
    feedback(state: TerminalScrollState) {
      if (state.gestureId === gestureId && state.status === "cancelled") { cancelled = true; pending.length = 0; }
      if (inFlight && state.gestureId === inFlight.gestureId && state.sequence === inFlight.sequence) {
        inFlight = null; schedule();
      }
    },
  };
}

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
