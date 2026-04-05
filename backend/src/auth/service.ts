import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { AuthConfig } from "./config";
import type { AuthStore, PersistedRefreshSessionRecord } from "./store";
import { issueToken, verifyToken, type SignedTokenType, type TokenResource } from "./jwt";

interface LoginParams {
  clientType: "web" | "electron";
  connectionId?: string;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
}

interface AccessTokenSession {
  sessionId: string;
  username: string;
}

interface TemporaryTokenVerification {
  sessionId: string;
  username: string;
  tokenType: SignedTokenType;
  resource: TokenResource;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toIsoAfter(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function isRefreshSessionActive(session: PersistedRefreshSessionRecord): boolean {
  if (session.revokedAt) {
    return false;
  }
  return Date.now() < Date.parse(session.expiresAt);
}

export class AuthService {
  private readonly refreshSessions = new Map<string, PersistedRefreshSessionRecord>();

  constructor(
    private readonly config: AuthConfig & {
      initialRefreshSessions?: PersistedRefreshSessionRecord[];
    },
    private readonly authStore?: Pick<
      AuthStore,
      | "createRefreshSession"
      | "replaceRefreshSession"
      | "revokeRefreshSession"
      | "revokeRefreshSessions"
      | "updatePassword"
    >,
  ) {
    for (const session of config.initialRefreshSessions ?? []) {
      this.refreshSessions.set(session.id, structuredClone(session));
    }
  }

  async login(
    username: string,
    password: string,
    params: LoginParams = { clientType: "web" },
  ): Promise<LoginResult | null> {
    if (
      username !== this.config.username ||
      password !== this.config.password
    ) {
      return null;
    }

    const sessionId = randomUUID();
    const accessToken = issueToken({
      username,
      sessionId,
      secret: this.config.jwtSecret,
      ttlMs: this.config.accessTokenTtlMs,
      tokenType: "access",
    });
    const refreshToken = issueToken({
      username,
      sessionId,
      secret: this.config.jwtSecret,
      ttlMs: this.config.refreshTokenTtlMs,
      tokenType: "refresh",
    });
    const now = new Date().toISOString();
    const record: PersistedRefreshSessionRecord = {
      id: sessionId,
      username,
      tokenHash: hashToken(refreshToken.token),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: toIsoAfter(this.config.refreshTokenTtlMs),
      revokedAt: null,
      replacedBySessionId: null,
      clientType: params.clientType,
      connectionId: params.connectionId ?? null,
    };
    this.refreshSessions.set(record.id, record);
    await this.authStore?.createRefreshSession(record);

    return {
      accessToken: accessToken.token,
      refreshToken: refreshToken.token,
      sessionId,
      expiresIn: accessToken.expiresIn,
    };
  }

  verifyToken(token: string): boolean {
    return this.verifyAccessToken(token) !== null;
  }

  verifyAccessToken(token: string): AccessTokenSession | null {
    const verified = verifyToken(token, this.config.jwtSecret);
    if (!verified.valid || !verified.payload || verified.payload.type !== "access") {
      return null;
    }

    const refreshSession = this.refreshSessions.get(verified.payload.sid);
    if (!refreshSession || !isRefreshSessionActive(refreshSession)) {
      return null;
    }

    return {
      sessionId: verified.payload.sid,
      username: verified.payload.sub,
    };
  }

  async refreshSession(refreshToken: string): Promise<LoginResult | null> {
    const verified = verifyToken(refreshToken, this.config.jwtSecret);
    if (!verified.valid || !verified.payload || verified.payload.type !== "refresh") {
      return null;
    }

    const refreshSession = this.refreshSessions.get(verified.payload.sid);
    if (!refreshSession || !isRefreshSessionActive(refreshSession)) {
      return null;
    }
    if (refreshSession.tokenHash !== hashToken(refreshToken)) {
      return null;
    }

    const nextSessionId = randomUUID();
    const nextRefreshToken = issueToken({
      username: verified.payload.sub,
      sessionId: nextSessionId,
      secret: this.config.jwtSecret,
      ttlMs: this.config.refreshTokenTtlMs,
      tokenType: "refresh",
    });
    const accessToken = issueToken({
      username: verified.payload.sub,
      sessionId: nextSessionId,
      secret: this.config.jwtSecret,
      ttlMs: this.config.accessTokenTtlMs,
      tokenType: "access",
    });
    const now = new Date().toISOString();
    const nextSession: PersistedRefreshSessionRecord = {
      ...refreshSession,
      id: nextSessionId,
      tokenHash: hashToken(nextRefreshToken.token),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: toIsoAfter(this.config.refreshTokenTtlMs),
      revokedAt: null,
      replacedBySessionId: null,
    };
    this.refreshSessions.set(refreshSession.id, {
      ...refreshSession,
      revokedAt: now,
      replacedBySessionId: nextSession.id,
    });
    this.refreshSessions.set(nextSession.id, nextSession);
    await this.authStore?.replaceRefreshSession(refreshSession.id, nextSession);

    return {
      accessToken: accessToken.token,
      refreshToken: nextRefreshToken.token,
      sessionId: nextSession.id,
      expiresIn: accessToken.expiresIn,
    };
  }

  async logoutSession(accessToken: string): Promise<boolean> {
    const current = this.verifyAccessToken(accessToken);
    if (!current) {
      return false;
    }
    const now = new Date().toISOString();
    const record = this.refreshSessions.get(current.sessionId);
    if (record) {
      this.refreshSessions.set(current.sessionId, { ...record, revokedAt: now });
    }
    await this.authStore?.revokeRefreshSession(current.sessionId, now);
    return true;
  }

  issueTemporaryToken(
    username: string,
    ttlMs: number,
  ): { token: string; expiresIn: number };
  issueTemporaryToken(params: {
    sessionId: string;
    tokenType: "viewer-ws" | "terminal-ws" | "devtools";
    resource: TokenResource;
    ttlMs: number;
  }): { token: string; expiresIn: number };
  issueTemporaryToken(
    usernameOrParams:
      | string
      | {
          sessionId: string;
          tokenType: "viewer-ws" | "terminal-ws" | "devtools";
          resource: TokenResource;
          ttlMs: number;
        },
    ttlMs?: number,
  ): { token: string; expiresIn: number } {
    if (typeof usernameOrParams === "string") {
      return issueToken({
        username: usernameOrParams,
        sessionId: "",
        secret: this.config.jwtSecret,
        ttlMs: ttlMs ?? 60_000,
        tokenType: "legacy-temp",
      });
    }

    const refreshSession = this.refreshSessions.get(usernameOrParams.sessionId);
    if (!refreshSession || !isRefreshSessionActive(refreshSession)) {
      return issueToken({
        username: "",
        sessionId: usernameOrParams.sessionId,
        secret: this.config.jwtSecret,
        ttlMs: 1,
        tokenType: usernameOrParams.tokenType,
        resource: usernameOrParams.resource,
      });
    }

    return issueToken({
      username: refreshSession.username,
      sessionId: usernameOrParams.sessionId,
      secret: this.config.jwtSecret,
      ttlMs: usernameOrParams.ttlMs,
      tokenType: usernameOrParams.tokenType,
      resource: usernameOrParams.resource,
    });
  }

  verifyTemporaryToken(
    token: string,
    params: {
      tokenType: "viewer-ws" | "terminal-ws" | "devtools";
      resource: TokenResource;
    },
  ): TemporaryTokenVerification | null {
    const verified = verifyToken(token, this.config.jwtSecret);
    if (
      !verified.valid ||
      !verified.payload ||
      verified.payload.type !== params.tokenType
    ) {
      return null;
    }
    const refreshSession = this.refreshSessions.get(verified.payload.sid);
    if (!refreshSession || !isRefreshSessionActive(refreshSession)) {
      return null;
    }

    const actual = verified.payload.resource ?? {};
    if (
      actual.sessionId !== params.resource.sessionId ||
      actual.terminalSessionId !== params.resource.terminalSessionId ||
      actual.tabId !== params.resource.tabId
    ) {
      return null;
    }

    return {
      sessionId: verified.payload.sid,
      username: verified.payload.sub,
      tokenType: verified.payload.type,
      resource: actual,
    };
  }

  async changePassword(
    accessToken: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const current = this.verifyAccessToken(accessToken);
    if (!current || oldPassword !== this.config.password) {
      return false;
    }

    const updatedAt = new Date().toISOString();
    await this.authStore?.updatePassword({
      password: newPassword,
      jwtSecret: this.config.jwtSecret,
      updatedAt,
    });
    this.config.password = newPassword;
    const record = this.refreshSessions.get(current.sessionId);
    if (record) {
      this.refreshSessions.set(current.sessionId, {
        ...record,
        revokedAt: updatedAt,
      });
    }
    await this.authStore?.revokeRefreshSession(current.sessionId, updatedAt);
    return true;
  }
}
