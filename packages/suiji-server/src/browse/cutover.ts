import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../db/pool";
import { digest } from "../records/mutations";
import { invalid } from "../errors";
import { getRecord } from "../records/repository";
import { followupRows } from "../followups/repository";
import * as browse from "./repository";
import { lockHead, bump } from "../work-records/repository";

async function inventory(c: pg.PoolClient, owner: string) {
  const records = (
    await c.query(
      "SELECT r.id FROM records r JOIN record_materials m ON m.owner_id=r.owner_id AND m.record_id=r.id WHERE r.owner_id=$1 AND migrated_browse_id IS NULL ORDER BY r.id",
      [owner],
    )
  ).rows;
  const items = [];
  for (const row of records) {
    const record = await getRecord(c, owner, row.id, false, true);
    const revisions = (
      await c.query(
        "SELECT version,snapshot FROM record_revisions WHERE owner_id=$1 AND record_id=$2 ORDER BY version",
        [owner, row.id],
      )
    ).rows;
    const followups = await followupRows(c, owner, row.id, 2147483647);
    const attachments = (
      await c.query(
        "SELECT id,sha256,byte_size,bound_record_id FROM attachments WHERE owner_id=$1 AND bound_record_id=$2 ORDER BY id",
        [owner, row.id],
      )
    ).rows;
    const results = (
      await c.query(
        "SELECT * FROM material_results WHERE owner_id=$1 AND record_id=$2 ORDER BY record_version",
        [owner, row.id],
      )
    ).rows;
    items.push({ record, revisions, followups, attachments, results });
  }
  const facts = (
    await c.query(
      "SELECT * FROM work_facts WHERE owner_id=$1 ORDER BY id",
      [owner],
    )
  ).rows;
  const sources = (await c.query("SELECT * FROM work_sources WHERE owner_id=$1 AND source_scope ~ '^(browser|materials|browse):' ORDER BY source_scope,effective_from", [owner])).rows;
  return { items, facts, sources };
}
export async function cutover(
  pool: pg.Pool,
  owner: string,
  expectedHash?: string,
) {
  return transaction(pool, async (c) => {
    // Same owner lock precedes all product mutations, including old frozen requests.
    await c.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [owner]);
    await c.query(
      "LOCK TABLE records,record_materials,record_revisions,record_followups,attachments,record_attachments,followup_attachments IN SHARE ROW EXCLUSIVE MODE",
    );
    const prior = (
      await c.query("SELECT audit FROM browse_cutovers WHERE owner_id=$1", [
        owner,
      ])
    ).rows[0];
    if (prior) return { ...prior.audit, alreadyCompleted: true };
    const data = await inventory(c, owner);
    const hash = digest(data);
    const audit = {
      hash,
      records: data.items.length,
      deleted: data.items.filter((i) => i.record.deletedAt).length,
      attachments: data.items.reduce((n, i) => n + i.attachments.length, 0),
      revisions: data.items.reduce((n, i) => n + i.revisions.length, 0),
      followups: data.items.reduce((n, i) => n + i.followups.length, 0),
      excluded: 0,
      needsReview: 0,
      closedSources: data.sources,
    };
    for (const f of data.facts) {
      const refs = f.source_snapshot?.sourceRefs ?? [];
      const blocked = refs.filter(
        (r: { channel: string; sourceScope: string }) =>
          ["browser-visit", "suiji-material"].includes(r.channel) ||
          /^(browser|materials|browse):/.test(r.sourceScope),
      );
      if (blocked.length) {
        if (blocked.length === refs.length) audit.excluded++;
        else audit.needsReview++;
      }
    }
    if (!expectedHash) return { ...audit, dryRun: true };
    if (expectedHash !== hash) throw invalid("迁移清点已变化，请重新 dry-run");
    await browse.lockHead(c, owner);
    for (const item of data.items) {
      const r = item.record,
        m = r.material!;
      const input = {
        captureId: m.captureId,
        browseDate: m.materialDate,
        occurredAt: null,
        capturedAt: m.capturedAt,
        title:
          m.inputType === "image"
            ? "保存的图片"
            : m.inputType === "link"
              ? "保存的链接"
              : "保存的文字",
        body: r.body,
        userNote: "",
        source: {
          provider: "unknown",
          displayName: "未标注",
          connectionId: null,
        },
        contentType: m.inputType,
        captureMethod: "legacy" as const,
        sourceUrl: m.sourceUrl ?? null,
        contentState: { state: "available" as const, reason: null },
        attachmentIds: r.attachments.map((a) => a.id),
      };
      await browse.insertEntry(c, owner, r.id, input);
      await c.query(
        "UPDATE browse_entries SET version=$3,deleted_at=$4 WHERE owner_id=$1 AND id=$2",
        [owner, r.id, r.version, r.deletedAt],
      );
      await c.query(
        "INSERT INTO browse_legacy_archives VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          owner,
          r.id,
          JSON.stringify(r),
          JSON.stringify(item.revisions),
          JSON.stringify(item.followups),
          JSON.stringify(item.attachments),
          JSON.stringify(item.results),
        ],
      );
      await c.query(
        "DELETE FROM record_attachments WHERE owner_id=$1 AND record_id=$2",
        [owner, r.id],
      );
      await c.query(
        "DELETE FROM followup_attachments WHERE owner_id=$1 AND record_id=$2",
        [owner, r.id],
      );
      await c.query(
        "UPDATE attachments SET bound_record_id=NULL,bound_browse_id=$2 WHERE owner_id=$1 AND bound_record_id=$2",
        [owner, r.id],
      );
      for (const a of item.attachments)
        await c.query(
          "INSERT INTO browse_legacy_attachments VALUES($1,$2,$3)",
          [owner, r.id, a.id],
        );
      for (const a of r.attachments)
        await c.query("INSERT INTO browse_attachments VALUES($1,$2,$3,$4)", [
          owner,
          r.id,
          a.id,
          a.position,
        ]);
      await browse.snapshot(c, owner, r.id);
      await c.query(
        "UPDATE records SET migrated_browse_id=$2 WHERE owner_id=$1 AND id=$2",
        [owner, r.id],
      );
      await c.query(
        "INSERT INTO record_change_heads(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
        [owner],
      );
      const n = (
        await c.query(
          "UPDATE record_change_heads SET sequence=sequence+1 WHERE owner_id=$1 RETURNING sequence",
          [owner],
        )
      ).rows[0].sequence;
      await c.query(
        "INSERT INTO record_changes(owner_id,sequence,record_id,kind,actor,record_version,deleted) VALUES($1,$2,$3,'record_changed','app',$4,true)",
        [owner, n, r.id, r.version],
      );
    }
    await lockHead(c, owner);
    await c.query(
      `UPDATE work_facts f SET eligibility=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(source_snapshot->'sourceRefs') r WHERE r->>'channel' NOT IN ('browser-visit','suiji-material') AND coalesce(r->>'sourceScope','') !~ '^(browser|materials|browse):') THEN 'needs-review' ELSE 'excluded' END
      WHERE owner_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(source_snapshot->'sourceRefs') r WHERE r->>'channel' IN ('browser-visit','suiji-material') OR r->>'sourceScope' ~ '^(browser|materials|browse):')`,
      [owner],
    );
    await c.query(
      `UPDATE work_reports w SET needs_review=true WHERE owner_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.source_facts) r JOIN work_facts f ON f.owner_id=w.owner_id AND f.id=(r->>'id')::uuid WHERE f.eligibility<>'eligible')`,
      [owner],
    );
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    await c.query(
      "DELETE FROM work_sources WHERE owner_id=$1 AND source_scope ~ '^(browser|materials|browse):' AND effective_from >= $2::date",
      [owner, today],
    );
    await c.query(
      "UPDATE work_sources SET effective_to=$2::date WHERE owner_id=$1 AND source_scope ~ '^(browser|materials|browse):' AND (effective_to IS NULL OR effective_to>$2::date)",
      [owner, today],
    );
    if (audit.excluded || audit.needsReview || data.sources.length) await bump(c, owner);
    await c.query("INSERT INTO browse_cutovers(owner_id,audit) VALUES($1,$2)", [
      owner,
      JSON.stringify(audit),
    ]);
    return { ...audit, completed: true, operationId: randomUUID() };
  });
}
