type TerminalWheelEvent = Pick<WheelEvent, "deltaY" | "shiftKey">;

export function shouldSuppressWheelInput(
  event: TerminalWheelEvent,
  canScrollTerminalBuffer: boolean,
): boolean {
  if (canScrollTerminalBuffer || event.shiftKey || event.deltaY === 0) {
    return false;
  }

  return true;
}
