import type { RequestHandler } from "express";

export function webCors(origins: string): RequestHandler {
  const allowed = new Set(origins.split(",").filter(Boolean));
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.vary("Origin");
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
        return;
      }
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Expose-Headers", "X-Request-Id,Retry-After");
    }
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.set(
        "Access-Control-Allow-Headers",
        "Authorization,Content-Type,Idempotency-Key",
      );
      res.status(204).end();
      return;
    }
    next();
  };
}
