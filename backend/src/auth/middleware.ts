import type { Request, RequestHandler } from "express";
import type { AuthService } from "./service";

function getBearerToken(request: Request): string | null {
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

export function createRequireAuth(authService: AuthService): RequestHandler {
  return (req, res, next) => {
    const token = getBearerToken(req);
    if (!token || !authService.verifyAccessToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    next();
  };
}

export function readBearerToken(request: Request): string | null {
  return getBearerToken(request);
}
