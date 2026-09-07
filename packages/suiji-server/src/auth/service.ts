import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { SuijiTokens } from "@runweave/shared/suiji";
import type { Config } from "../config";
import { transaction } from "../db/pool";
import { unauthenticated, ServiceError } from "../errors";
import { hashPassword, verifyPassword } from "./password";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export type AuthContext = {
  ownerId: string;
  serverId: string;
  sessionId: string;
};
export class AuthService {
  private failures = new Map<string, { count: number; until: number }>();
  private dummy = hashPassword(randomBytes(32).toString("hex"));
  constructor(
    private pool: pg.Pool,
    private config: Config,
  ) {}
  private checkLimit(keys: string[]) {
    const now = Date.now();
    for (const [key, entry] of this.failures)
      if (entry.until <= now) this.failures.delete(key);
    for (const key of keys) {
      const entry = this.failures.get(key);
      if (entry && entry.count >= this.config.SUIJI_LOGIN_ATTEMPTS)
        throw new ServiceError(429, "RATE_LIMITED", "登录尝试过多", {
          retryAfter: Math.ceil((entry.until - now) / 1000),
        });
    }
    // Count in-flight attempts too; concurrent requests cannot bypass the limit.
    if (
      this.failures.size + keys.filter((k) => !this.failures.has(k)).length >
      10000
    )
      throw new ServiceError(429, "RATE_LIMITED", "请稍后再试", {
        retryAfter: 60,
      });
    for (const key of keys) {
      const old = this.failures.get(key);
      this.failures.set(key, {
        count: (old?.count ?? 0) + 1,
        until:
          old?.until ?? now + this.config.SUIJI_LOGIN_WINDOW_SECONDS * 1000,
      });
    }
  }
  async login(
    username: string,
    password: string,
    source: string,
  ): Promise<SuijiTokens> {
    const keys = [`ip:${hash(source)}`, `account:${hash(username)}`];
    this.checkLimit(keys);
    const owner = (
      await this.pool.query(
        "SELECT id,username,password_hash FROM owners WHERE singleton",
      )
    ).rows[0];
    const matches = await verifyPassword(
      password,
      owner?.password_hash ?? (await this.dummy),
    );
    if (!owner || owner.username !== username || !matches)
      throw unauthenticated();
    const result = await transaction(this.pool, async (client) => {
      // Serialize with password reset, then recheck the hash observed before the expensive KDF.
      const current = (
        await client.query(
          "SELECT password_hash FROM owners WHERE id=$1 FOR UPDATE",
          [owner.id],
        )
      ).rows[0];
      if (current.password_hash !== owner.password_hash)
        throw unauthenticated();
      return this.issue(client, owner.id, randomUUID(), false);
    });
    for (const key of keys) this.failures.delete(key);
    return result;
  }
  private async issue(
    client: pg.PoolClient,
    ownerId: string,
    sessionId: string,
    update: boolean,
  ): Promise<SuijiTokens> {
    const accessToken = randomBytes(32).toString("base64url"),
      refreshToken = randomBytes(48).toString("base64url");
    const values = [
      sessionId,
      ownerId,
      hash(accessToken),
      hash(refreshToken),
      this.config.SUIJI_ACCESS_SECONDS,
      this.config.SUIJI_REFRESH_SECONDS,
    ];
    await client.query(
      update
        ? `UPDATE sessions SET access_hash=$3,refresh_hash=$4,access_expires_at=now()+$5*interval '1 second',refresh_expires_at=now()+$6*interval '1 second' WHERE id=$1 AND owner_id=$2`
        : `INSERT INTO sessions(id,owner_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second',now()+$6*interval '1 second')`,
      values,
    );
    const { server_id: serverId } = (
      await client.query("SELECT server_id FROM server_identity")
    ).rows[0];
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.SUIJI_ACCESS_SECONDS,
      sessionId,
      ownerId,
      serverId,
    };
  }
  async refresh(token: string) {
    return transaction(this.pool, async (client) => {
      const session = (
        await client.query(
          "SELECT id,owner_id FROM sessions WHERE refresh_hash=$1 AND revoked_at IS NULL AND refresh_expires_at>now() FOR UPDATE",
          [hash(token)],
        )
      ).rows[0];
      if (!session) throw unauthenticated();
      return this.issue(client, session.owner_id, session.id, true);
    });
  }
  async authenticate(token: string): Promise<AuthContext> {
    const row = (
      await this.pool.query(
        `SELECT s.id,s.owner_id,i.server_id FROM sessions s CROSS JOIN server_identity i WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at>now()`,
        [hash(token)],
      )
    ).rows[0];
    if (!row) throw unauthenticated();
    return {
      ownerId: row.owner_id,
      serverId: row.server_id,
      sessionId: row.id,
    };
  }
  async logout(auth: AuthContext) {
    await this.pool.query(
      "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND owner_id=$2",
      [auth.sessionId, auth.ownerId],
    );
  }
}
