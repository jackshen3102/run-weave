import { Router } from "express";
import { z } from "zod";
import type {
  ChangePasswordRequest,
  LoginRequest,
} from "@browser-viewer/shared";
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

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
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

function resolveClientType(request: { headers: Record<string, unknown> }): "web" | "electron" {
  return request.headers["x-auth-client"] === "electron" ? "electron" : "web";
}

export function createAuthRouter(
  authService: AuthService,
  options?: {
    refreshCookieName?: string;
    secureCookies?: boolean;
  },
): Router {
  const router = Router();
  const refreshCookieName = options?.refreshCookieName ?? "viewer_refresh";
  const secureCookies = options?.secureCookies ?? true;

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
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    if (clientType === "web") {
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
    const refreshToken =
      clientType === "electron"
        ? refreshSchema.safeParse(req.body).success
          ? refreshSchema.parse(req.body).refreshToken
          : null
        : parseCookieHeader(req.headers.cookie)[refreshCookieName] ?? null;
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
