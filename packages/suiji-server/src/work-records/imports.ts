import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  ImportWorkFacts,
  WorkFactInput,
  WorkImportResult,
} from "@runweave/shared/suiji";
import { digest, type Mutation } from "../records/mutations";
import { ServiceError } from "../errors";
import * as repo from "./repository";

function sourceError(reason: string): never {
  throw new ServiceError(
    400,
    "INVALID_ARGUMENT",
    "来源时间或身份与已有事实冲突",
    { reason },
  );
}
export async function importFacts(
  client: pg.PoolClient,
  ctx: Mutation,
  input: ImportWorkFacts,
): Promise<WorkImportResult> {
  const head = await repo.lockHead(client, ctx.ownerId);
  if (head !== input.basedOnFeedRevision) repo.changed(head);
  const result: WorkImportResult = {
    importId: randomUUID(),
    feedRevision: head,
    created: 0,
    updated: 0,
    unchanged: 0,
    protected: 0,
    facts: [],
  };
  await client.query(
    "INSERT INTO work_import_runs(owner_id,id,source_namespace,source_collected_at,request_id,receipt) VALUES($1,$2,$3,$4,$5,'{}')",
    [
      ctx.ownerId,
      result.importId,
      input.sourceNamespace,
      input.sourceCollectedAt,
      ctx.requestId,
    ],
  );
  let changed = false;
  for (const day of input.days) {
    const registered = await client.query<{source_scope: string; source_namespace: string}>(
      "SELECT source_scope,source_namespace FROM work_sources WHERE owner_id=$1 AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>$2::date) AND source_scope=ANY($3::text[])",
      [ctx.ownerId, day.date, day.requestedScopes]);
    if (registered.rows.some(r => r.source_namespace !== input.sourceNamespace))
      sourceError("SOURCE_NAMESPACE_MISMATCH");
    for (const source of day.facts) {
      const refs = [...source.sourceRefs].sort((a, b) =>
        digest(a).localeCompare(digest(b)),
      );
      const snapshot = {
        workDate: day.date,
        eventKey: source.eventKey,
        title: source.title,
        statement: source.statement,
        status: source.status,
        project: source.project,
        sourceRefs: refs,
      };
      const hash = digest(snapshot);
      const collectedAt = new Date(
        Math.max(
          ...refs.map((ref) =>
            Date.parse(
              day.receipts.find((r) => r.sourceScope === ref.sourceScope)!
                .collectedAt,
            ),
          ),
        ),
      );
      let row = (
        await client.query<repo.WorkRow>(
          `SELECT ${repo.columns} FROM work_facts WHERE owner_id=$1 AND source_namespace=$2 AND external_key=$3 FOR UPDATE`,
          [ctx.ownerId, input.sourceNamespace, source.externalKey],
        )
      ).rows[0];
      if (row) {
        if (row.event_key !== source.eventKey)
          sourceError("EVENT_IDENTITY_CHANGED");
        const oldTime = row.source_collected_at!.valueOf();
        if (collectedAt.valueOf() < oldTime)
          sourceError("SOURCE_TIME_REGRESSED");
        if (collectedAt.valueOf() === oldTime && row.source_hash !== hash)
          sourceError("SAME_TIME_DIFFERENT_SNAPSHOT");
        if (row.manual_fields.length) result.protected++;
        if (row.source_hash === hash) {
          result.unchanged++;
          await client.query(
            "UPDATE work_facts SET source_collected_at=$3 WHERE owner_id=$1 AND id=$2",
            [ctx.ownerId, row.id, collectedAt],
          );
        } else {
          const value: WorkFactInput = {
            workDate: day.date,
            title: source.title,
            statement: source.statement,
            status: source.status,
            project: source.project,
          };
          const old = repo.fact(row);
          for (const field of row.manual_fields)
            Object.assign(value, { [field]: old[field] });
          row = (
            await client.query<repo.WorkRow>(
              `UPDATE work_facts SET work_date=$3,title=$4,statement=$5,status=$6,project=$7,source_snapshot=$8,source_hash=$9,source_collected_at=$10,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING ${repo.columns}`,
              [
                ctx.ownerId,
                row.id,
                value.workDate,
                value.title,
                value.statement,
                value.status,
                value.project,
                JSON.stringify(snapshot),
                hash,
                collectedAt,
              ],
            )
          ).rows[0]!;
          result.updated++;
          changed = true;
          await repo.revision(client, ctx, row);
        }
      } else {
        row = (
          await client.query<repo.WorkRow>(
            `INSERT INTO work_facts(id,owner_id,event_key,work_date,title,statement,status,project,created_via,source_namespace,external_key,source_snapshot,source_hash,source_collected_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent',$9,$10,$11,$12,$13) RETURNING ${repo.columns}`,
            [
              randomUUID(),
              ctx.ownerId,
              source.eventKey,
              day.date,
              source.title,
              source.statement,
              source.status,
              source.project,
              input.sourceNamespace,
              source.externalKey,
              JSON.stringify(snapshot),
              hash,
              collectedAt,
            ],
          )
        ).rows[0]!;
        result.created++;
        changed = true;
        await repo.revision(client, ctx, row);
      }
      result.facts.push({
        externalKey: source.externalKey,
        id: row.id,
        version: row.version,
        sourceHash: hash,
        fact: repo.fact(row),
      });
    }
    for (const receipt of day.receipts) {
      const old = (
        await client.query<{
          status: string;
          collected_at: Date;
          window_from: Date;
          window_to: Date;
        }>(
          "SELECT * FROM work_day_coverage WHERE owner_id=$1 AND work_date=$2 AND source_scope=$3 FOR UPDATE",
          [ctx.ownerId, day.date, receipt.sourceScope],
        )
      ).rows[0];
      if (old && Date.parse(receipt.collectedAt) < old.collected_at.valueOf())
        sourceError("COVERAGE_TIME_REGRESSED");
      if (
        old &&
        Date.parse(receipt.collectedAt) === old.collected_at.valueOf() &&
        old.status !== receipt.status
      )
        sourceError("SAME_TIME_DIFFERENT_COVERAGE");
      if (!old || old.status !== receipt.status) changed = true;
      await client.query(
        `INSERT INTO work_day_coverage(owner_id,work_date,source_scope,status,collected_at,window_from,window_to,import_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(owner_id,work_date,source_scope) DO UPDATE SET status=excluded.status,collected_at=excluded.collected_at,window_from=excluded.window_from,window_to=excluded.window_to,import_id=excluded.import_id`,
        [
          ctx.ownerId,
          day.date,
          receipt.sourceScope,
          receipt.status,
          receipt.collectedAt,
          receipt.from,
          receipt.to,
          result.importId,
        ],
      );
    }
  }
  if (changed) result.feedRevision = await repo.bump(client, ctx.ownerId);
  await client.query(
    "UPDATE work_import_runs SET receipt=$3 WHERE owner_id=$1 AND id=$2",
    [ctx.ownerId, result.importId, JSON.stringify(result)],
  );
  return result;
}
