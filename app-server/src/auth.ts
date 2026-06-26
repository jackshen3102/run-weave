import crypto from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Request, Response, NextFunction } from "express";

export async function loadOrCreateToken(tokenPath: string): Promise<string> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (token) {
      await chmod(tokenPath, 0o600).catch(() => undefined);
      return token;
    }
  } catch {
    // Create below.
  }

  const token = crypto.randomBytes(32).toString("base64url");
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenPath, 0o600).catch(() => undefined);
  return token;
}

export function rejectNonLoopbackOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isLoopbackOrigin(req.header("origin"))) {
    next();
    return;
  }

  res.status(403).json({ message: "Loopback origin required" });
}

export function requireBearerToken(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (readBearerToken(req.header("authorization")) !== token) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    next();
  };
}

export function isAuthorizedWebSocketRequest(
  request: IncomingMessage,
  token: string,
): boolean {
  if (!isLoopbackOrigin(request.headers.origin)) {
    return false;
  }
  return readBearerToken(request.headers.authorization) === token;
}

function readBearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function isLoopbackOrigin(origin: string | string[] | undefined): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}
