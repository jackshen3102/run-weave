import type http from "node:http";
import type { Socket } from "node:net";
import type { WebSocketServer } from "ws";

/** Owns HTTP/WS transports, but never the domain services behind them. */
export class TransportRuntime {
  private readonly connections = new Set<Socket>();
  private readonly webSocketServers: WebSocketServer[] = [];
  private disposal: Promise<void> | null = null;

  constructor(readonly server: http.Server) {
    server.on("connection", (connection) => {
      this.connections.add(connection);
      connection.once("close", () => this.connections.delete(connection));
    });
  }

  addWebSocket(server: WebSocketServer): void {
    this.webSocketServers.push(server);
  }

  dispose(): Promise<void> {
    this.disposal ??= this.close();
    return this.disposal;
  }

  private async close(): Promise<void> {
    const httpClosed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        ) {
          reject(error);
        } else resolve();
      });
    });
    const socketsClosed = this.webSocketServers.map((server) => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
    for (const connection of this.connections) connection.destroy();
    const results = await Promise.allSettled([httpClosed, ...socketsClosed]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Transport cleanup failed");
  }
}
