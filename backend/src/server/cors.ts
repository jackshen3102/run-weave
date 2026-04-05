import type { RequestHandler } from "express";

function isAllowedLocalOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

export function createCorsMiddleware(
  configuredOrigins: string[],
): RequestHandler {
  const allowedOrigins = new Set(configuredOrigins);
  const allowedHeaders = [
    "Content-Type",
    "Authorization",
    "X-Auth-Client",
    "X-Connection-Id",
  ];

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (allowedOrigins.has(origin) || isAllowedLocalOrigin(origin))
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      allowedHeaders.join(","),
    );

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
