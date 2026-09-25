import { safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { desktopStateRoot, writePrivateJson } from "../desktop/local-state.js";
interface Credential {
  target: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  installationId: string | null;
}
export class TunnelCredentials {
  private readonly file = path.join(
    desktopStateRoot(),
    "tunnels",
    "credentials.enc",
  );
  private unreadable = false;
  private values: Record<string, Credential> = {};
  private refreshing = new Map<string, Promise<string>>();
  constructor() {
    if (existsSync(this.file)) {
      if (!safeStorage.isEncryptionAvailable()) return;
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
          encrypted: string;
        };
        this.values = JSON.parse(
          safeStorage.decryptString(Buffer.from(raw.encrypted, "base64")),
        ) as Record<string, Credential>;
      } catch {
        this.unreadable = true;
      }
    }
  }
  private persist() {
    if (!safeStorage.isEncryptionAvailable()) return;
    if (this.unreadable && existsSync(this.file)) {
      writePrivateJson(
        `${this.file}.bad`,
        JSON.parse(readFileSync(this.file, "utf8")),
      );
      this.unreadable = false;
    }
    writePrivateJson(this.file, {
      encrypted: safeStorage
        .encryptString(JSON.stringify(this.values))
        .toString("base64"),
    });
  }
  isPersistent() {
    return safeStorage.isEncryptionAvailable();
  }
  forget(id: string) {
    if (!this.values[id]) return;
    delete this.values[id];
    this.persist();
  }
  private async request(base: string, route: string, body: unknown) {
    const response = await fetch(`${base}/api/auth/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-client": "electron",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "NEEDS_AUTH: 请登录远端 Runweave"
          : "AUTH_UNAVAILABLE: 远端认证服务暂不可用",
      );
    const result = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };
    if (
      typeof result.accessToken !== "string" ||
      typeof result.refreshToken !== "string" ||
      !Number.isFinite(result.expiresIn)
    )
      throw new Error("AUTH_UNAVAILABLE: 远端认证响应不完整");
    return result;
  }
  async login(
    id: string,
    target: string,
    base: string,
    username: string,
    password: string,
  ) {
    const result = await this.request(base, "login", { username, password });
    this.values[id] = {
      target,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      installationId: null,
    };
    this.persist();
  }
  async token(id: string, target: string, base: string): Promise<string> {
    const current = this.values[id];
    if (!current || current.target !== target)
      throw new Error("NEEDS_AUTH: 请登录远端 Runweave");
    if (current.expiresAt > Date.now() + 30000) return current.accessToken;
    const existing = this.refreshing.get(id);
    if (existing) return existing;
    const operation = (async () => {
      const result = await this.request(base, "refresh", {
        refreshToken: current.refreshToken,
      });
      if (this.values[id] !== current)
        throw new Error("NEEDS_AUTH: 登录状态已变化");
      this.values[id] = {
        ...current,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      };
      this.persist();
      return result.accessToken;
    })().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, operation);
    return operation;
  }
  verifyInstallation(id: string, installationId: string) {
    const current = this.values[id];
    if (!current) return;
    if (current.installationId && current.installationId !== installationId)
      throw new Error(
        "BACKEND_IDENTITY_CHANGED: 远端 Backend 身份已变化，请重新登录",
      );
    current.installationId = installationId;
    this.persist();
  }
  invalidateAccess(id: string) {
    const current = this.values[id];
    if (current) current.expiresAt = 0;
  }
}
