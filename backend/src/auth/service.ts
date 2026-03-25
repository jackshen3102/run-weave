import type { AuthConfig } from "./config";
import { issueToken, verifyToken } from "./jwt";

export class AuthService {
  constructor(private readonly config: AuthConfig) {}

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
}
