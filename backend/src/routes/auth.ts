import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type {
  AuthClientType,
  ChangePasswordRequest,
  LoginRequest,
} from "@runweave/shared";
import {
  LoginAttemptGuard,
  type LoginAttemptDecision,
} from "../auth/login-attempt-guard";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

function parseCookieHeader(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex < 0) {
          return [entry, ""];
        }
        return [
          entry.slice(0, separatorIndex),
          decodeURIComponent(entry.slice(separatorIndex + 1)),
        ];
      }),
  );
}

function buildRefreshCookie(params: {
  name: string;
  value: string;
  secure: boolean;
  maxAgeSeconds?: number;
  clear?: boolean;
}): string {
  const segments = [
    `${params.name}=${encodeURIComponent(params.value)}`,
    "Path=/api/auth",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (params.secure) {
    segments.push("Secure");
  }
  if (params.clear) {
    segments.push("Max-Age=0");
    segments.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else if (params.maxAgeSeconds != null) {
    segments.push(`Max-Age=${params.maxAgeSeconds}`);
  }
  return segments.join("; ");
}

function resolveClientType(request: {
  headers: Record<string, unknown>;
}): AuthClientType {
  const header = request.headers["x-auth-client"];
  return header === "electron" || header === "app" ? header : "web";
}

function usesBodyRefreshToken(clientType: AuthClientType): boolean {
  return clientType === "electron" || clientType === "app";
}

function readFirstHeader(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.trim() || null;
}

function readForwardedIp(request: Request): string | null {
  const cloudflareIp = readFirstHeader(request.headers["cf-connecting-ip"]);
  if (cloudflareIp) {
    return cloudflareIp;
  }

  const forwardedFor = readFirstHeader(request.headers["x-forwarded-for"]);
  return forwardedFor?.split(",")[0]?.trim() || null;
}

function resolveLoginRequestIp(
  request: Request,
  trustProxyHeaders: boolean,
): string {
  return (
    (trustProxyHeaders ? readForwardedIp(request) : null) ??
    request.ip ??
    request.socket.remoteAddress ??
    "unknown"
  );
}

function sendRateLimitedLoginResponse(
  res: Response,
  decision: LoginAttemptDecision,
): void {
  if (decision.retryAfterSeconds != null) {
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  }
  res.status(429).json({ message: "Too many login attempts" });
}

export function createAuthRouter(
  authService: AuthService,
  options?: {
    refreshCookieName?: string;
    secureCookies?: boolean;
    loginAttemptGuard?: LoginAttemptGuard;
    trustProxyHeaders?: boolean;
  },
): Router {
  const router = Router();
  const refreshCookieName = options?.refreshCookieName ?? "viewer_refresh";
  const secureCookies = options?.secureCookies ?? true;
  const loginAttemptGuard =
    options?.loginAttemptGuard ?? new LoginAttemptGuard();
  const trustProxyHeaders = options?.trustProxyHeaders ?? false;

  router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body as LoginRequest);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const clientType = resolveClientType(req);
    const loginIdentity = {
      ip: resolveLoginRequestIp(req, trustProxyHeaders),
      username: parsed.data.username,
    };
    const existingLimit = loginAttemptGuard.check(loginIdentity);
    if (!existingLimit.allowed) {
      sendRateLimitedLoginResponse(res, existingLimit);
      return;
    }
    const attemptLimit = loginAttemptGuard.recordAttempt(loginIdentity);
    if (!attemptLimit.allowed) {
      sendRateLimitedLoginResponse(res, attemptLimit);
      return;
    }

    const result = await authService.login(
      parsed.data.username,
      parsed.data.password,
      {
        clientType,
        connectionId:
          typeof req.headers["x-connection-id"] === "string"
            ? req.headers["x-connection-id"]
            : undefined,
      },
    );
    if (!result) {
      loginAttemptGuard.recordFailure(loginIdentity);
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    loginAttemptGuard.recordSuccess(loginIdentity);
    if (!usesBodyRefreshToken(clientType)) {
      res.setHeader(
        "Set-Cookie",
        buildRefreshCookie({
          name: refreshCookieName,
          value: result.refreshToken,
          secure: secureCookies,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        }),
      );
      res.status(200).json({
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        sessionId: result.sessionId,
      });
      return;
    }

    res.status(200).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      sessionId: result.sessionId,
    });
  });

  router.post("/refresh", async (req, res) => {
    const clientType = resolveClientType(req);
    const refreshToken = usesBodyRefreshToken(clientType)
      ? refreshSchema.safeParse(req.body).success
        ? refreshSchema.parse(req.body).refreshToken
        : null
      : (parseCookieHeader(req.headers.cookie)[refreshCookieName] ?? null);
    if (!refreshToken) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const refreshed = await authService.refreshSession(refreshToken);
    if (!refreshed) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    if (clientType === "web") {
      res.setHeader(
        "Set-Cookie",
        buildRefreshCookie({
          name: refreshCookieName,
          value: refreshed.refreshToken,
          secure: secureCookies,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        }),
      );
      res.status(200).json({
        accessToken: refreshed.accessToken,
        expiresIn: refreshed.expiresIn,
        sessionId: refreshed.sessionId,
      });
      return;
    }

    res.status(200).json({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresIn: refreshed.expiresIn,
      sessionId: refreshed.sessionId,
    });
  });

  router.get("/verify", (req, res) => {
    const token = readBearerToken(req);
    if (!token || !authService.verifyAccessToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    res.status(200).json({ valid: true });
  });

  router.post("/logout", async (req, res) => {
    const token = readBearerToken(req);
    if (!token || !authService.verifyAccessToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    await authService.logoutSession(token);
    res.setHeader(
      "Set-Cookie",
      buildRefreshCookie({
        name: refreshCookieName,
        value: "",
        secure: secureCookies,
        clear: true,
      }),
    );
    res.status(204).send();
  });

  router.post("/password", async (req, res) => {
    const token = readBearerToken(req);
    if (!token || !authService.verifyAccessToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = changePasswordSchema.safeParse(
      req.body as ChangePasswordRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const changed = await authService.changePassword(
      token,
      parsed.data.oldPassword,
      parsed.data.newPassword,
    );
    if (!changed) {
      res.status(403).json({ message: "Invalid credentials" });
      return;
    }

    res.setHeader(
      "Set-Cookie",
      buildRefreshCookie({
        name: refreshCookieName,
        value: "",
        secure: secureCookies,
        clear: true,
      }),
    );
    res.status(204).send();
  });

  return router;
}
