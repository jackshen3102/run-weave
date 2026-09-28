import type pg from "pg";
import type { CorrectionLexicon, CorrectionLexiconEntry } from "@runweave/shared/suiji";
import { mutate, type Mutation } from "../records/mutations";
import { ServiceError } from "../errors";
import { validateEntries } from "./schema";

export class CorrectionLexicons {
  constructor(private pool: pg.Pool) {}
  async get(owner: string): Promise<CorrectionLexicon> {
    const row = await this.pool.query("SELECT version,entries FROM correction_lexicons WHERE owner_id=$1", [owner]);
    return row.rows[0] ?? { version: 0, entries: [] };
  }
  async put(context: Mutation, input: { expectedVersion: number; entries: CorrectionLexiconEntry[] }): Promise<CorrectionLexicon> {
    const entries = validateEntries(input.entries);
    return mutate(this.pool, context, "correction-lexicon-put", { ...input, entries }, async (client) => {
      // Lock the owner even before the first lexicon row exists.
      await client.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [context.ownerId]);
      const current = await client.query("SELECT version FROM correction_lexicons WHERE owner_id=$1 FOR UPDATE", [context.ownerId]);
      const version: number = current.rows[0]?.version ?? 0;
      if (version !== input.expectedVersion)
        throw new ServiceError(409, "VERSION_CONFLICT", "词库已在另一设备更新，请重新读取", { currentVersion: version });
      const next = version + 1;
      await client.query(`INSERT INTO correction_lexicons(owner_id,version,entries) VALUES($1,$2,$3)
        ON CONFLICT(owner_id) DO UPDATE SET version=$2,entries=$3,updated_at=clock_timestamp()`, [context.ownerId, next, JSON.stringify(entries)]);
      return { version: next, entries };
    });
  }
}
