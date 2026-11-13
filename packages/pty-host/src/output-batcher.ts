import { OUTPUT_FRAME_MAX_BYTES, type TerminalOutputFrame } from "./output-recovery";

/** Batch live frames without changing their stream boundaries or replay cursors. */
export function createHostOutputBatcher(send: (frame: TerminalOutputFrame) => void) {
  let pending: TerminalOutputFrame | undefined;
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const frame = pending;
    pending = undefined;
    if (frame && !disposed) send(frame);
  };
  return {
    push(frame: TerminalOutputFrame) {
      if (disposed) return;
      if (pending && (pending.range.streamId !== frame.range.streamId ||
        pending.range.toOffset !== frame.range.fromOffset ||
        frame.range.toOffset - pending.range.fromOffset > OUTPUT_FRAME_MAX_BYTES)) flush();
      pending = pending ? {
        data: pending.data + frame.data,
        range: { ...pending.range, toOffset: frame.range.toOffset },
      } : frame;
      if (pending.range.toOffset - pending.range.fromOffset >= OUTPUT_FRAME_MAX_BYTES) flush();
      else if (!timer) {
        timer = setTimeout(flush, 16);
        timer.unref();
      }
    },
    flush,
    dispose() {
      disposed = true;
      pending = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
