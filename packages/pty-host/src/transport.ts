import type { Socket } from "node:net";

export class HostTransportError extends Error {
  constructor(readonly code: string, readonly bufferedBytes: number, readonly limitBytes = 4 * 1024 * 1024) {
    super(code);
  }
}

export function receiveJsonLines(socket: Socket, onMessage: (message: unknown) => void): void {
  let source = "";
  socket.setEncoding("utf8");
  socket.on("data", data => {
    source += data;
    if (Buffer.byteLength(source) > 4 * 1024 * 1024) return socket.destroy(new HostTransportError("HOST_MESSAGE_TOO_LARGE", Buffer.byteLength(source)));
    let end;
    while ((end = source.indexOf("\n")) !== -1) {
      const line = source.slice(0, end);
      source = source.slice(end + 1);
      try { onMessage(JSON.parse(line)); }
      catch { socket.destroy(new Error("HOST_MESSAGE_INVALID")); return; }
    }
  });
}

export function sendJson(socket: Socket, message: unknown): boolean {
  if (socket.destroyed) return false;
  if (socket.writableLength > 4 * 1024 * 1024) {
    socket.destroy(new HostTransportError("HOST_OUTPUT_GAP", socket.writableLength));
    return false;
  }
  socket.write(JSON.stringify(message) + "\n");
  return true;
}
