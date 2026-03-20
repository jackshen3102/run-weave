import type { ConnectionContext } from "./context";
import { resolveCursorAtPoint } from "./cursor";

export function createCursorSyncController(params: {
  state: ConnectionContext;
  cursorSyncIntervalMs: number;
  emitCursor: (cursor: string) => void;
}): {
  scheduleLookup: (x: number, y: number) => void;
  dispose: () => void;
} {
  const { state, cursorSyncIntervalMs, emitCursor } = params;

  const runCursorLookup = async (): Promise<void> => {
    if (!state.cdpSession || state.cursorLookupInFlight || !state.pendingCursorPoint) {
      return;
    }

    const point = state.pendingCursorPoint;
    state.pendingCursorPoint = null;
    state.cursorLookupInFlight = true;
    state.lastCursorLookupAt = Date.now();

    try {
      const cursor = await resolveCursorAtPoint(state.cdpSession, point.x, point.y);
      emitCursor(cursor);
    } catch {
      emitCursor("default");
    } finally {
      state.cursorLookupInFlight = false;
    }

    if (state.pendingCursorPoint && !state.cursorLookupTimer) {
      const elapsed = Date.now() - state.lastCursorLookupAt;
      const delay = Math.max(0, cursorSyncIntervalMs - elapsed);
      state.cursorLookupTimer = setTimeout(() => {
        state.cursorLookupTimer = null;
        void runCursorLookup();
      }, delay);
      state.cursorLookupTimer.unref?.();
    }
  };

  const scheduleLookup = (x: number, y: number): void => {
    state.pendingCursorPoint = { x, y };
    if (!state.cdpSession || state.cursorLookupInFlight || state.cursorLookupTimer) {
      return;
    }

    const elapsed = Date.now() - state.lastCursorLookupAt;
    const delay = Math.max(0, cursorSyncIntervalMs - elapsed);
    state.cursorLookupTimer = setTimeout(() => {
      state.cursorLookupTimer = null;
      void runCursorLookup();
    }, delay);
    state.cursorLookupTimer.unref?.();
  };

  const dispose = (): void => {
    if (!state.cursorLookupTimer) {
      return;
    }
    clearTimeout(state.cursorLookupTimer);
    state.cursorLookupTimer = null;
  };

  return { scheduleLookup, dispose };
}
