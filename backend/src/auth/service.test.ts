import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./service";
import type { AuthStore, PersistedRefreshSessionRecord } from "./store";

function createMemoryAuthStore() {
  const sessions = new Map<string, PersistedRefreshSessionRecord>();

  const store: Pick<
    AuthStore,
    | "createRefreshSession"
    | "getRefreshSession"
    | "replaceRefreshSession"
    | "revokeRefreshSession"
    | "revokeRefreshSessions"
    | "updatePassword"
  > = {
    createRefreshSession: vi.fn(async (session) => {
      sessions.set(session.id, structuredClone(session));
    }),
    getRefreshSession: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? structuredClone(session) : null;
    }),
    replaceRefreshSession: vi.fn(async (sessionId, nextSession) => {
      const current = sessions.get(sessionId);
      if (!current) {
        throw new Error("Missing session");
      }
      if (nextSession.id === sessionId) {
        sessions.set(sessionId, structuredClone(nextSession));
        return;
      }
      sessions.set(sessionId, {
        ...current,
        revokedAt: nextSession.createdAt,
        replacedBySessionId: nextSession.id,
      });
      sessions.set(nextSession.id, structuredClone(nextSession));
    }),
    revokeRefreshSession: vi.fn(async (sessionId, revokedAt) => {
      const current = sessions.get(sessionId);
      if (!current) {
        return null;
      }
      const next = { ...current, revokedAt };
      sessions.set(sessionId, next);
      return structuredClone(next);
    }),
    revokeRefreshSessions: vi.fn(async (sessionIds, revokedAt) => {
      for (const sessionId of sessionIds) {
        const current = sessions.get(sessionId);
        if (!current) {
          continue;
        }
        sessions.set(sessionId, { ...current, revokedAt });
      }
    }),
    updatePassword: vi.fn(async ({ password, updatedAt }) => ({
      username: "admin",
      password,
      jwtSecret: "jwt-secret",
      updatedAt,
      refreshSessions: Array.from(sessions.values()),
    })),
  };

  return { sessions, store };
}

describe("AuthService", () => {
  it("issues access and refresh tokens for valid credentials", async () => {
    const { store, sessions } = createMemoryAuthStore();
    const service = new AuthService(
      {
        username: "admin",
        password: "secret",
        jwtSecret: "jwt-secret",
        accessTokenTtlMs: 15 * 60_000,
        refreshTokenTtlMs: 30 * 24 * 60 * 60_000,
        refreshCookieName: "viewer_refresh",
        secureCookies: false,
      },
      store,
    );

    const result = await service.login("admin", "secret", {
      clientType: "electron",
      connectionId: "conn-1",
    });

    expect(result).toBeTruthy();
    expect(typeof result?.accessToken).toBe("string");
    expect(typeof result?.refreshToken).toBe("string");
    expect(typeof result?.sessionId).toBe("string");
    expect(result?.expiresIn).toBe(15 * 60);
    expect(service.verifyAccessToken(result!.accessToken)).toBeTruthy();
    expect(sessions.size).toBe(1);
  });

  it("rejects invalid credentials", async () => {
    const { store } = createMemoryAuthStore();
    const service = new AuthService(
      {
        username: "admin",
        password: "secret",
        jwtSecret: "jwt-secret",
        accessTokenTtlMs: 60_000,
        refreshTokenTtlMs: 120_000,
        refreshCookieName: "viewer_refresh",
        secureCookies: false,
      },
      store,
    );

    await expect(
      service.login("admin", "wrong", { clientType: "web" }),
    ).resolves.toBeNull();
  });

  it("rotates refresh tokens without invalidating the current access token", async () => {
    const { store } = createMemoryAuthStore();
    const service = new AuthService(
      {
        username: "admin",
        password: "secret",
        jwtSecret: "jwt-secret",
        accessTokenTtlMs: 60_000,
        refreshTokenTtlMs: 120_000,
        refreshCookieName: "viewer_refresh",
        secureCookies: false,
      },
      store,
    );

    const issued = await service.login("admin", "secret", {
      clientType: "electron",
      connectionId: "conn-1",
    });
    expect(issued).toBeTruthy();

    const refreshed = await service.refreshSession(issued!.refreshToken!);
    expect(refreshed).toBeTruthy();
    expect(refreshed?.sessionId).toBe(issued?.sessionId);
    expect(refreshed?.refreshToken).not.toBe(issued?.refreshToken);

    await expect(
      service.refreshSession(issued!.refreshToken!),
    ).resolves.toBeNull();
    expect(service.verifyAccessToken(issued!.accessToken)).toBeTruthy();
    expect(service.verifyAccessToken(refreshed!.accessToken)).toBeTruthy();
  });

  it("revokes only the current session on logout", async () => {
    const { store } = createMemoryAuthStore();
    const service = new AuthService(
      {
        username: "admin",
        password: "secret",
        jwtSecret: "jwt-secret",
        accessTokenTtlMs: 60_000,
        refreshTokenTtlMs: 120_000,
        refreshCookieName: "viewer_refresh",
        secureCookies: false,
      },
      store,
    );

    const first = await service.login("admin", "secret", { clientType: "web" });
    const second = await service.login("admin", "secret", {
      clientType: "electron",
      connectionId: "conn-2",
    });
    expect(first && second).toBeTruthy();

    await expect(service.logoutSession(first!.accessToken)).resolves.toBe(true);

    expect(service.verifyAccessToken(first!.accessToken)).toBeNull();
    expect(service.verifyAccessToken(second!.accessToken)).toBeTruthy();
    await expect(service.refreshSession(first!.refreshToken!)).resolves.toBeNull();
    await expect(service.refreshSession(second!.refreshToken!)).resolves.toBeTruthy();
  });

  it("changes password and invalidates only the current session", async () => {
    const { store } = createMemoryAuthStore();
    const service = new AuthService(
      {
        username: "admin",
        password: "secret",
        jwtSecret: "jwt-secret",
        accessTokenTtlMs: 60_000,
        refreshTokenTtlMs: 120_000,
        refreshCookieName: "viewer_refresh",
        secureCookies: false,
      },
      store,
    );

    const current = await service.login("admin", "secret", { clientType: "web" });
    const other = await service.login("admin", "secret", {
      clientType: "electron",
      connectionId: "conn-2",
    });
    expect(current && other).toBeTruthy();

    await expect(
      service.changePassword(current!.accessToken, "secret", "new-secret"),
    ).resolves.toBe(true);

    expect(service.verifyAccessToken(current!.accessToken)).toBeNull();
    expect(service.verifyAccessToken(other!.accessToken)).toBeTruthy();
    expect(await service.refreshSession(current!.refreshToken!)).toBeNull();
    expect(await service.refreshSession(other!.refreshToken!)).toBeTruthy();
    await expect(
      service.login("admin", "new-secret", { clientType: "web" }),
    ).resolves.toBeTruthy();
  });

  it("issues scoped temporary tickets", async () => {
    const { store } = createMemoryAuthStore();
    const service = new AuthService(
      {
        username: "admin",
        password: "secret",
        jwtSecret: "jwt-secret",
        accessTokenTtlMs: 60_000,
        refreshTokenTtlMs: 120_000,
        refreshCookieName: "viewer_refresh",
        secureCookies: false,
      },
      store,
    );

    const issued = await service.login("admin", "secret", { clientType: "web" });
    expect(issued).toBeTruthy();

    const ticket = service.issueTemporaryToken({
      sessionId: issued!.sessionId,
      tokenType: "viewer-ws",
      resource: { sessionId: "browser-session-1" },
      ttlMs: 60_000,
    });

    expect(ticket.expiresIn).toBe(60);
    expect(
      service.verifyTemporaryToken(ticket.token, {
        tokenType: "viewer-ws",
        resource: { sessionId: "browser-session-1" },
      }),
    ).toEqual({
      sessionId: issued!.sessionId,
      tokenType: "viewer-ws",
      resource: { sessionId: "browser-session-1" },
      username: "admin",
    });
  });
});
