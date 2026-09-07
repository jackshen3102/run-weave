import { createHash } from "node:crypto";
import type pg from "pg";
import { transaction } from "../db/pool";
import { ServiceError } from "../errors";
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export type Mutation = {
  ownerId: string;
  actor: "app" | "agent";
  key: string;
  requestId: string;
};
export async function mutate<T>(
  pool: pg.Pool,
  context: Mutation,
  operation: string,
  input: unknown,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  // Keep the M1 App hash stable: existing pending requests must still replay.
  const sourceOperation = context.actor === "agent" ? `agent:${operation}` : operation;
  const requestHash = digest({ operation: sourceOperation, input });
  return transaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO mutation_requests(owner_id,idempotency_key,request_hash,operation,request_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING owner_id`,
      [context.ownerId, context.key, requestHash, sourceOperation, context.requestId],
    );
    if (!inserted.rowCount) {
      const old = (
        await client.query(
          "SELECT request_hash,response FROM mutation_requests WHERE owner_id=$1 AND idempotency_key=$2",
          [context.ownerId, context.key],
        )
      ).rows[0];
      if (old.request_hash !== requestHash)
        throw new ServiceError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "操作键已用于其他请求",
        );
      return old.response as T;
    }
    const result = await work(client);
    await client.query(
      "UPDATE mutation_requests SET response=$3 WHERE owner_id=$1 AND idempotency_key=$2",
      [context.ownerId, context.key, JSON.stringify(result)],
    );
    return result;
  });
}
