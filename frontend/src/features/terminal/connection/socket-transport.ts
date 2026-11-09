import type { TerminalClientMessage } from "@runweave/shared/terminal/websocket";
import { toWebSocketBase } from "../navigation/url";

export function buildTerminalWsUrl(
  apiBase: string,
  terminalSessionId: string,
  ticket: string,
  includeSnapshot: boolean,
): string {
  const searchParams = new URLSearchParams({
    terminalSessionId,
    token: ticket,
  });
  if (!includeSnapshot) {
    searchParams.set("snapshot", "0");
  }
  return `${toWebSocketBase(apiBase)}/ws/terminal?${searchParams.toString()}`;
}

export function sendMessage(
  socket: WebSocket | null,
  payload: TerminalClientMessage,
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

