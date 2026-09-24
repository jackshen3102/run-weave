import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

interface Ticket {
  endpoint: string;
  expiresAt: number;
}

export interface RemoteBrowserGateway {
  port: number;
  key: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 8_192;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export async function createRemoteBrowserGateway(input: {
  connectionId: string;
  generation: number;
  allowedProfileId: TerminalBrowserProfileId | null;
  approvedBrowserGroupId: string | null;
  cdpEndpoint: string;
}): Promise<RemoteBrowserGateway> {
  const key = randomBytes(32).toString("hex");
  const tickets = new Map<string, Ticket>();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.headers["x-runweave-gateway-key"] !== key) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === "GET" && req.url === "/check") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          connectionId: input.connectionId,
          generation: input.generation,
        }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/issue") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        connectionId?: unknown;
        generation?: unknown;
        projectId?: unknown;
        terminalSessionId?: unknown;
        explicitProfileId?: unknown;
        browserGroupId?: unknown;
      };
      if (request.connectionId !== input.connectionId ||
          request.generation !== input.generation ||
          typeof request.projectId !== "string" || !request.projectId || request.projectId.length > 256 ||
          typeof request.terminalSessionId !== "string" || !request.terminalSessionId || request.terminalSessionId.length > 256 ||
          (request.browserGroupId !== null && request.browserGroupId !== undefined &&
            request.browserGroupId !== input.approvedBrowserGroupId) ||
          (request.explicitProfileId !== null && request.explicitProfileId !== undefined &&
            request.explicitProfileId !== input.allowedProfileId)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "BROWSER_SCOPE_DENIED" }));
        return;
      }
      for (const [id, ticket] of tickets) {
        if (ticket.expiresAt < Date.now()) tickets.delete(id);
      }
      if (tickets.size >= 64 || sockets.size >= 16) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "BROWSER_CAPACITY_EXCEEDED" }));
        return;
      }
      const scope = {
        projectId: `${input.connectionId}:${request.projectId}`,
        terminalSessionId: `${input.connectionId}:${request.terminalSessionId}`,
        browserGroupId: request.browserGroupId ?? null,
        explicitProfileId: input.allowedProfileId,
      };
      const response = await fetch(`${input.cdpEndpoint}/runweave/browser-profile/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope),
        signal: AbortSignal.timeout(5_000),
      });
      const resolution = (await response.json().catch(() => null)) as {
        profileId?: unknown; browserGroupId?: unknown; cdpEndpoint?: unknown; error?: { code?: string };
      } | null;
      if (!response.ok || typeof resolution?.cdpEndpoint !== "string" ||
          typeof resolution.profileId !== "string" || typeof resolution.browserGroupId !== "string") {
        res.writeHead(response.status >= 400 ? response.status : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: resolution?.error?.code ?? "DESKTOP_UNAVAILABLE" }));
        return;
      }
      const ticket = randomBytes(32).toString("hex");
      tickets.set(ticket, { endpoint: resolution.cdpEndpoint, expiresAt: Date.now() + 60_000 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket, profileId: resolution.profileId, browserGroupId: resolution.browserGroupId }));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ code: "DESKTOP_UNAVAILABLE" }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const match = /^\/ticket\/([0-9a-f]{64})$/.exec(req.url ?? "");
    const ticketId = match?.[1];
    const ticket = ticketId ? tickets.get(ticketId) : undefined;
    if (ticketId) tickets.delete(ticketId);
    if (!ticket || ticket.expiresAt < Date.now()) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (downstream) => {
      const upstream = new WebSocket(ticket.endpoint, { maxPayload: MAX_FRAME_BYTES });
      sockets.add(downstream);
      sockets.add(upstream);
      const closeBoth = () => {
        downstream.close();
        upstream.close();
        sockets.delete(downstream);
        sockets.delete(upstream);
      };
      upstream.on("open", () => {
        downstream.on("message", (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
            closeBoth(); return;
          }
          upstream.send(data, { binary: isBinary });
        });
        upstream.on("message", (data, isBinary) => {
          if (downstream.readyState !== WebSocket.OPEN || downstream.bufferedAmount > MAX_BUFFERED_BYTES) {
            closeBoth(); return;
          }
          downstream.send(data, { binary: isBinary });
        });
      });
      upstream.on("error", closeBoth);
      downstream.on("error", closeBoth);
      upstream.on("close", closeBoth);
      downstream.on("close", closeBoth);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser bridge did not bind");
  return {
    port: address.port,
    key,
    close: async () => {
      tickets.clear();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wss.close();
    },
  };
}
