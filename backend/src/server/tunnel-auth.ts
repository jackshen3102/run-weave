import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Request, RequestHandler, Response } from "express";

export interface TunnelAuthConfig {
  token: string;
  cookieName: string;
  scope: "forwarded" | "all";
}

const DEFAULT_COOKIE_NAME = "runweave_tunnel";
const FORWARDED_HEADER_NAMES = [
  "cf-connecting-ip",
  "cf-ray",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name) {
      cookies.set(name, safeDecodeURIComponent(value));
    }
  }

  return cookies;
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

function readQueryToken(
  request: IncomingMessage,
  includeGenericToken: boolean,
): string | null {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  return (
    requestUrl.searchParams.get("tunnelToken") ??
    requestUrl.searchParams.get("tunnel_token") ??
    (includeGenericToken ? requestUrl.searchParams.get("token") : null)
  );
}

function readCookieToken(
  request: IncomingMessage,
  cookieName: string,
): string | null {
  return parseCookieHeader(request.headers.cookie).get(cookieName) ?? null;
}

function hasForwardedHeaders(request: IncomingMessage): boolean {
  return FORWARDED_HEADER_NAMES.some(
    (headerName) => request.headers[headerName] !== undefined,
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function matchesToken(candidate: string | null, expected: string): boolean {
  if (!candidate) {
    return false;
  }

  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function shouldSetSecureCookie(request: Request): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return request.secure || proto?.split(",")[0]?.trim() === "https";
}

function writeTunnelCookie(
  response: Response,
  request: Request,
  config: TunnelAuthConfig,
): void {
  const attrs = [
    `${config.cookieName}=${encodeURIComponent(config.token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (shouldSetSecureCookie(request)) {
    attrs.push("Secure");
  }
  response.setHeader("Set-Cookie", attrs.join("; "));
}

export function loadTunnelAuthConfig(
  env: NodeJS.ProcessEnv,
): TunnelAuthConfig | null {
  const token = env.RUNWEAVE_TUNNEL_TOKEN?.trim();
  if (!token) {
    return null;
  }

  return {
    token,
    cookieName: env.RUNWEAVE_TUNNEL_COOKIE_NAME?.trim() || DEFAULT_COOKIE_NAME,
    scope:
      env.RUNWEAVE_TUNNEL_AUTH_SCOPE?.trim().toLowerCase() === "all"
        ? "all"
        : "forwarded",
  };
}

export function shouldRequireTunnelAuth(
  request: IncomingMessage,
  config: TunnelAuthConfig | null | undefined,
): boolean {
  if (!config) {
    return false;
  }

  if (config.scope === "all") {
    return true;
  }

  return (
    hasForwardedHeaders(request) ||
    !isLoopbackAddress(request.socket.remoteAddress)
  );
}

export function isTunnelRequestAuthorized(
  request: IncomingMessage,
  config: TunnelAuthConfig | null | undefined,
  options?: {
    includeGenericQueryToken?: boolean;
  },
): boolean {
  if (!config || !shouldRequireTunnelAuth(request, config)) {
    return true;
  }

  const includeGenericQueryToken = options?.includeGenericQueryToken ?? false;
  return (
    matchesToken(readCookieToken(request, config.cookieName), config.token) ||
    matchesToken(readQueryToken(request, includeGenericQueryToken), config.token) ||
    matchesToken(readBearerToken(request), config.token)
  );
}

export function createTunnelAuthMiddleware(
  config: TunnelAuthConfig | null,
): RequestHandler {
  return (req, res, next) => {
    if (!config || !shouldRequireTunnelAuth(req, config)) {
      next();
      return;
    }

    const queryToken = readQueryToken(req, true);
    if (
      matchesToken(readCookieToken(req, config.cookieName), config.token) ||
      matchesToken(queryToken, config.token) ||
      matchesToken(readBearerToken(req), config.token)
    ) {
      if (matchesToken(queryToken, config.token)) {
        writeTunnelCookie(res, req, config);
      }
      next();
      return;
    }

    res.status(401).json({ message: "Tunnel token required" });
  };
}

export function createTunnelTokenBootstrapMiddleware(
  config: TunnelAuthConfig | null,
): RequestHandler {
  return (req, res, next) => {
    if (!config) {
      next();
      return;
    }

    const queryToken = readQueryToken(req, true);
    if (matchesToken(queryToken, config.token)) {
      writeTunnelCookie(res, req, config);
    }
    next();
  };
}

export function rejectUnauthorizedTunnelUpgrade(socket: Duplex): void {
  socket.write(
    "HTTP/1.1 401 Unauthorized\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: 12\r\n" +
      "\r\n" +
      "Unauthorized",
  );
  socket.destroy();
}
