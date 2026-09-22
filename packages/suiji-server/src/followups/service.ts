import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  SUIJI_LIMITS,
  type AppendFollowup,
  type FollowupPage,
  type FollowupResponse,
} from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { invalid, missing } from "../errors";
import { mutate, type Mutation } from "../records/mutations";
import { followupRows, followupSummaries } from "./repository";

export class FollowupService {
  constructor(private pool: pg.Pool) {}
  async list(
    owner: string,
    recordId: string,
    input: { cursor?: string; limit: number },
    includeTrash = false,
  ): Promise<FollowupPage> {
    let before: number | undefined;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        );
        if (
          cursor.owner !== owner ||
          cursor.recordId !== recordId ||
          !Number.isSafeInteger(cursor.before) ||
          cursor.before < 1
        )
          throw new Error();
        before = cursor.before;
      } catch {
        throw invalid("游标与当前记录不匹配");
      }
    }
    return transaction(this.pool, async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const parent = await client.query(
        `SELECT id FROM records WHERE owner_id=$1 AND id=$2 ${includeTrash ? "" : "AND deleted_at IS NULL"}`,
        [owner, recordId],
      );
      if (!parent.rowCount) throw missing();
      const rows = await followupRows(
        client,
        owner,
        recordId,
        input.limit + 1,
        before,
      );
      const items = rows.slice(0, input.limit);
      return {
        items,
        nextCursor:
          rows.length > input.limit
            ? Buffer.from(
                JSON.stringify({
                  owner,
                  recordId,
                  before: items.at(-1)!.sequence,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  append(
    context: Mutation,
    recordId: string,
    input: AppendFollowup,
  ): Promise<FollowupResponse> {
    return mutate(
      this.pool,
      context,
      `followup:${recordId}`,
      input,
      async (client) => {
        const owner = context.ownerId;
        const parent = await client.query(
          "SELECT id FROM records WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
          [owner, recordId],
        );
        if (!parent.rowCount) throw missing();
        const ids = input.attachmentIds ?? [];
        if (!input.body.trim() && !ids.length)
          throw invalid("请输入跟进内容或添加附件");
        if (new Set(ids).size !== ids.length) throw invalid("附件不能重复");
        const files = await client.query(
          "SELECT id,kind,bound_record_id FROM attachments WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
          [owner, ids],
        );
        if (files.rows.length !== ids.length) throw missing();
        if (
          files.rows.some(
            (file) => file.bound_record_id && file.bound_record_id !== recordId,
          )
        )
          throw invalid("附件已属于另一条记录");
        if (
          files.rows.filter((file) => file.kind === "image").length >
            SUIJI_LIMITS.imagesPerRecord ||
          files.rows.filter((file) => file.kind === "markdown").length >
            SUIJI_LIMITS.markdownPerRecord
        )
          throw invalid("每条跟进最多一张图片和一个 Markdown");
        const id = randomUUID();
        await client.query(
          `INSERT INTO record_followups(id,owner_id,record_id,sequence,body,actor,agent_name,session_id)
        SELECT $1,$2,$3,coalesce(max(sequence),0)+1,$4,$5,$6,$7 FROM record_followups WHERE owner_id=$2 AND record_id=$3`,
          [
            id,
            owner,
            recordId,
            input.body,
            context.actor,
            context.actor === "agent" ? (input.agentName ?? null) : null,
            context.actor === "agent" ? (input.sessionId ?? null) : null,
          ],
        );
        await client.query(
          "UPDATE attachments SET bound_record_id=$3 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
          [owner, ids, recordId],
        );
        for (const [position, attachment] of ids.entries())
          await client.query(
            "INSERT INTO followup_attachments(owner_id,record_id,followup_id,attachment_id,position) VALUES($1,$2,$3,$4,$5)",
            [owner, recordId, id, attachment, position],
          );
        const [followup] = await followupRows(client, owner, recordId, 1);
        return {
          followup: followup!,
          followupSummary: (
            await followupSummaries(client, owner, [recordId])
          ).get(recordId)!,
        };
      },
    );
  }
}
