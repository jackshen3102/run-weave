import type { WebSocket } from "ws";

export interface HeartbeatState {
  heartbeatTimer: NodeJS.Timeout | null;
  isAlive: boolean;
}

export function createHeartbeatController(
  socket: WebSocket,
  state: HeartbeatState,
): {
  start: () => void;
  stop: () => void;
  markAlive: () => void;
} {
  const start = (): void => {
    state.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      if (!state.isAlive) {
        socket.terminate();
        return;
      }

      state.isAlive = false;
      socket.ping();
    }, 15_000);
    state.heartbeatTimer.unref?.();
  };

  const stop = (): void => {
    if (!state.heartbeatTimer) {
      return;
    }
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  };

  const markAlive = (): void => {
    state.isAlive = true;
  };

  return { start, stop, markAlive };
}
