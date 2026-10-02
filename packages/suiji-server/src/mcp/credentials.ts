import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { transaction } from "../db/pool";

const common = {
  version: z.literal(1),
  serverId: z.string().uuid(),
  ownerId: z.string().uuid(),
  name: z.string().trim().refine(v => [...v].length >= 1 && [...v].length <= 80),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime().refine(v => Number.isFinite(Date.parse(v))),
};
export const registrationSchema = z.object({ ...common, id: z.string().uuid() }).strict();
export const legacySchema = z.object(common).strict();
export class CredentialError extends Error {}
const fail = (code: string): never => { throw new CredentialError(code); };

export async function registerCredential(pool: pg.Pool, input: unknown, legacy = false) {
  const parsed = (legacy ? legacySchema : registrationSchema).safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT");
  const value = parsed.data;
  const id = "id" in value ? value.id : randomUUID();
  return transaction(pool, async client => {
    // Serialize administration, including revocation, across all CLI processes.
    await client.query("SELECT pg_advisory_xact_lock(78347833)");
    const identity = (await client.query(
      "SELECT server_id, id FROM server_identity CROSS JOIN owners WHERE owners.singleton",
    )).rows[0];
    if (!identity || identity.server_id !== value.serverId || identity.id !== value.ownerId)
      return fail("IDENTITY_MISMATCH");
    const existing = (await client.query(
      "SELECT *, expires_at <= clock_timestamp() AS expired FROM mcp_credentials WHERE id=$1 OR token_sha256=$2",
      [id, value.tokenSha256],
    )).rows;
    if (existing.length) {
      const row = existing[0];
      if (existing.length !== 1 || row.owner_id !== value.ownerId || row.token_sha256 !== value.tokenSha256 ||
          row.expires_at.toISOString() !== new Date(value.expiresAt).toISOString() ||
          (!legacy && (row.id !== id || row.name !== value.name || row.source !== "generated")))
        return fail("CREDENTIAL_CONFLICT");
      if (!legacy && (row.revoked_at || row.expired)) return fail("CREDENTIAL_INACTIVE");
      return { id: row.id as string, created: false };
    }
    if (!legacy) {
      const valid = (await client.query(
        "SELECT $1::timestamptz > clock_timestamp() AND $1::timestamptz <= clock_timestamp() + interval '365 days' AS valid",
        [value.expiresAt],
      )).rows[0].valid;
      if (!valid) return fail("INVALID_INPUT");
    }
    await client.query(
      "INSERT INTO mcp_credentials(id,owner_id,name,token_sha256,expires_at,source) VALUES($1,$2,$3,$4,$5,$6)",
      [id, value.ownerId, value.name, value.tokenSha256, value.expiresAt, legacy ? "legacy-import" : "generated"],
    );
    return { id, created: true };
  });
}

export async function listCredentials(pool: pg.Pool) {
  return (await pool.query(`SELECT c.id, c.name, c.created_at AS "createdAt", c.expires_at AS "expiresAt",
    c.revoked_at AS "revokedAt", c.last_used_at AS "lastUsedAt", c.source,
    CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked'
         WHEN c.expires_at <= clock_timestamp() THEN 'expired' ELSE 'active' END AS status
    FROM mcp_credentials c JOIN owners o ON o.id=c.owner_id AND o.singleton
    ORDER BY c.created_at, c.id`)).rows;
}

export async function revokeCredential(pool: pg.Pool, id: string) {
  if (!z.string().uuid().safeParse(id).success) return fail("INVALID_INPUT");
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(78347833)");
    const row = (await client.query(`UPDATE mcp_credentials SET revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE id=$1 AND owner_id=(SELECT id FROM owners WHERE singleton)
      RETURNING id, revoked_at AS "revokedAt"`, [id])).rows[0];
    if (!row) return fail("NOT_FOUND");
    return row;
  });
}
