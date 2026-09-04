import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { RequestHandler } from "express";
import { isLocalDirectHttpRequest } from "../../server/local-request";
import type { HttpUpgradeRouter } from "../../server/http-upgrade-router";
import {
  isWorkspaceServiceHostnameCandidate,
  parseRequestHostname,
} from "./identity";
import type { WorkspaceServiceManager } from "./manager";

const REMOVED_REQUEST_HEADERS = new Set([
  "connection",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const REMOVED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function buildForwardHeaders(
  headers: IncomingHttpHeaders,
  preserveUpgrade: boolean,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      (REMOVED_REQUEST_HEADERS.has(name.toLowerCase()) &&
        !(preserveUpgrade && (name === "connection" || name === "upgrade")))
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  forwarded["x-forwarded-for"] = "127.0.0.1";
  forwarded["x-forwarded-host"] = headers.host ?? "";
  forwarded["x-forwarded-proto"] = "http";
  return forwarded;
}

function writePlainResponse(
  socket: Duplex,
  status: number,
  reason: string,
): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${reason}\n`,
  );
}

export function createWorkspaceServiceHttpProxy(
  manager: WorkspaceServiceManager,
): RequestHandler {
  return (request, response, next) => {
    const hostname = parseRequestHostname(request.headers.host);
    if (!isWorkspaceServiceHostnameCandidate(hostname)) {
      next();
      return;
    }
    if (!isLocalDirectHttpRequest(request)) {
      response.status(403).setHeader("Cache-Control", "no-store");
      response.type("text/plain").send("Local request required\n");
      return;
    }
    const route = hostname ? manager.resolveProxyRoute(hostname) : null;
    if (!route) {
      response.status(404).setHeader("Cache-Control", "no-store");
      response.type("text/plain").send("Workspace service not found\n");
      return;
    }
    if (route.status !== "ready" || route.targetPort === null) {
      response.status(503).setHeader("Cache-Control", "no-store");
      response.type("text/plain").send(`Workspace service is ${route.status}\n`);
      return;
    }

    const proxyRequest = http.request(
      {
        host: "127.0.0.1",
        port: route.targetPort,
        method: request.method,
        path: request.originalUrl,
        headers: buildForwardHeaders(request.headers, false),
      },
      (proxyResponse) => {
        response.status(proxyResponse.statusCode ?? 502);
        for (const [name, value] of Object.entries(proxyResponse.headers)) {
          if (
            value !== undefined &&
            !REMOVED_RESPONSE_HEADERS.has(name.toLowerCase())
          ) {
            response.setHeader(name, value);
          }
        }
        proxyResponse.pipe(response);
      },
    );
    proxyRequest.once("error", () => {
      if (!response.headersSent) {
        response.status(502).setHeader("Cache-Control", "no-store");
        response.type("text/plain").send("Workspace service unavailable\n");
      } else {
        response.destroy();
      }
    });
    request.once("aborted", () => proxyRequest.destroy());
    request.pipe(proxyRequest);
  };
}

function buildUpgradeHead(request: http.IncomingMessage): string {
  const headers = buildForwardHeaders(request.headers, true);
  const lines = [
    `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function attachWorkspaceServiceUpgradeProxy(
  router: HttpUpgradeRouter,
  manager: WorkspaceServiceManager,
): void {
  router.register((request, socket, head) => {
    const hostname = parseRequestHostname(request.headers.host);
    if (!isWorkspaceServiceHostnameCandidate(hostname)) return false;
    if (!isLocalDirectHttpRequest(request)) {
      writePlainResponse(socket, 403, "Local request required");
      return true;
    }
    const route = hostname ? manager.resolveProxyRoute(hostname) : null;
    if (!route) {
      writePlainResponse(socket, 404, "Workspace service not found");
      return true;
    }
    if (route.status !== "ready" || route.targetPort === null) {
      writePlainResponse(socket, 503, `Workspace service is ${route.status}`);
      return true;
    }

    const target = net.createConnection({
      host: "127.0.0.1",
      port: route.targetPort,
    });
    const closeBoth = (): void => {
      target.destroy();
      socket.destroy();
    };
    target.once("connect", () => {
      target.write(buildUpgradeHead(request));
      if (head.length > 0) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.once("error", () => {
      if (!socket.destroyed) {
        writePlainResponse(socket, 502, "Workspace service unavailable");
      }
      target.destroy();
    });
    socket.once("error", closeBoth);
    socket.once("close", () => target.destroy());
    target.once("close", () => socket.destroy());
    return true;
  });
}
