import { createHash } from "node:crypto";
import type pg from "pg";
import { unauthenticated } from "../errors";

export class McpAuthenticationUnavailable extends Error {}

export async function authenticateMcp(pool: pg.Pool, authorization: string | undefined) {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw unauthenticated();
  let row;
  try {
    row = (await pool.query(`SELECT c.id, c.owner_id FROM mcp_credentials c
      JOIN owners o ON o.id=c.owner_id AND o.singleton
      WHERE c.token_sha256=$1 AND c.revoked_at IS NULL AND c.expires_at > clock_timestamp()`,
    [createHash("sha256").update(token).digest("hex")])).rows[0];
  } catch {
    throw new McpAuthenticationUnavailable();
  }
  if (!row) throw unauthenticated();
  // Telemetry is approximate; failure cannot turn failed authentication into success.
  await pool.query(`UPDATE mcp_credentials SET last_used_at=clock_timestamp()
    WHERE id=$1 AND revoked_at IS NULL AND
    (last_used_at IS NULL OR last_used_at <= clock_timestamp() - interval '1 minute')`, [row.id]).catch(() => {
    console.error(JSON.stringify({ event: "mcp_last_used_unavailable" }));
  });
  return { ownerId: row.owner_id as string, credentialId: row.id as string };
}
