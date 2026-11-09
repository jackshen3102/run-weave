import type { RefObject } from "react";

export function clearInputLagTimer(timer: RefObject<number | null>): void {
  if (timer.current === null) return;
  window.clearTimeout(timer.current);
  timer.current = null;
}
