import crypto from "node:crypto";
import type { AuthConfig } from "./config";
import type { AuthStore } from "./store";
import { issueToken, verifyToken } from "./jwt";

export class AuthService {
  constructor(
    private readonly config: AuthConfig,
    private readonly authStore?: Pick<AuthStore, "updatePassword">,
  ) {}

  login(
    username: string,
    password: string,
  ): { token: string; expiresIn: number } | null {
    if (
      username !== this.config.username ||
      password !== this.config.password
    ) {
      return null;
    }

    return issueToken(username, this.config.jwtSecret, this.config.tokenTtlMs);
  }

  verifyToken(token: string): boolean {
    return verifyToken(token, this.config.jwtSecret).valid;
  }

  issueTemporaryToken(
    username: string,
    ttlMs: number,
  ): { token: string; expiresIn: number } {
    return issueToken(username, this.config.jwtSecret, ttlMs);
  }

  async changePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    if (oldPassword !== this.config.password) {
      return false;
    }

    const nextJwtSecret = crypto.randomBytes(32).toString("base64url");
    const updatedAt = new Date().toISOString();
    await this.authStore?.updatePassword({
      password: newPassword,
      jwtSecret: nextJwtSecret,
      updatedAt,
    });
    this.config.password = newPassword;
    this.config.jwtSecret = nextJwtSecret;
    return true;
  }
}
