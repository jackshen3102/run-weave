import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Config } from "../config";
import { unauthenticated } from "../errors";

export async function authenticateMcp(
  pool: pg.Pool,
  config: Config,
  authorization: string | undefined,
) {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (
    !token ||
    !config.SUIJI_MCP_TOKEN_SHA256 ||
    !config.SUIJI_MCP_TOKEN_EXPIRES_AT ||
    Date.parse(config.SUIJI_MCP_TOKEN_EXPIRES_AT) <= Date.now()
  )
    throw unauthenticated();
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(config.SUIJI_MCP_TOKEN_SHA256, "hex");
  if (!timingSafeEqual(actual, expected)) throw unauthenticated();
  const result = await pool.query("SELECT id FROM owners WHERE singleton");
  if (!result.rows[0]) throw unauthenticated();
  return result.rows[0].id as string;
}
