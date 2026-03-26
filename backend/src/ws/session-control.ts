import type { WebSocket } from "ws";

export class WebSocketSessionController {
  private readonly socketsBySessionId = new Map<string, Set<WebSocket>>();

  register(sessionId: string, socket: WebSocket): void {
    const sockets = this.socketsBySessionId.get(sessionId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.socketsBySessionId.set(sessionId, sockets);
  }

  unregister(sessionId: string, socket: WebSocket): void {
    const sockets = this.socketsBySessionId.get(sessionId);
    if (!sockets) {
      return;
    }

    sockets.delete(socket);
    if (sockets.size === 0) {
      this.socketsBySessionId.delete(sessionId);
    }
  }

  disconnectSession(sessionId: string, reason = "Forced reconnect"): boolean {
    const sockets = this.socketsBySessionId.get(sessionId);
    if (!sockets || sockets.size === 0) {
      return false;
    }

    for (const socket of sockets) {
      socket.close(1012, reason);
    }

    return true;
  }

  getSessionConnectionCount(sessionId: string): number {
    return this.socketsBySessionId.get(sessionId)?.size ?? 0;
  }
}
