import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { CorrectionFeedback, CorrectionHistoryItem, CorrectionHistoryPage, CorrectionPreferences } from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { ServiceError, missing } from "../errors";
import { mutate, type Mutation } from "../records/mutations";

type HistoryRow = { id: string; correction_id: string; input_text: string; corrected_text: string;
  final_text: string | null; record_id: string | null; record_version: number | null;
  learning_epoch: number; status: string; created_at: Date; cursor_at?: string; finalized_at: Date | null };

const preference = (row?: { version: number; history_enabled: boolean; learning_epoch: number }): CorrectionPreferences => ({
  version: row?.version ?? 0, historyEnabled: row?.history_enabled ?? false, learningEpoch: row?.learning_epoch ?? 0,
});
const item = (row: HistoryRow): CorrectionHistoryItem => ({
  id: row.id, createdAt: row.created_at.toISOString(), finalizedAt: row.finalized_at!.toISOString(),
  inputText: row.input_text, correctedText: row.corrected_text, finalText: row.final_text!,
  recordId: row.record_id!, recordVersion: row.record_version!,
});
export class CorrectionHistory {
  constructor(private pool: pg.Pool) {}
  async preferences(owner: string): Promise<CorrectionPreferences> {
    const result = await this.pool.query("SELECT version,history_enabled,learning_epoch FROM correction_preferences WHERE owner_id=$1", [owner]);
    return preference(result.rows[0]);
  }
  put(context: Mutation, input: { expectedVersion: number; historyEnabled: boolean }) {
    return mutate(this.pool, context, "correction-preferences-put", input, async client => {
      await client.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [context.ownerId]);
      const old = preference((await client.query("SELECT version,history_enabled,learning_epoch FROM correction_preferences WHERE owner_id=$1 FOR UPDATE", [context.ownerId])).rows[0]);
      if (old.version !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "历史设置已在另一设备更新，请刷新");
      const next = { version: old.version + 1, historyEnabled: input.historyEnabled,
        learningEpoch: old.learningEpoch + (old.historyEnabled !== input.historyEnabled ? 1 : 0) };
      await client.query(`INSERT INTO correction_preferences(owner_id,version,history_enabled,learning_epoch) VALUES($1,$2,$3,$4)
        ON CONFLICT(owner_id) DO UPDATE SET version=$2,history_enabled=$3,learning_epoch=$4,updated_at=clock_timestamp()`,
        [context.ownerId, next.version, next.historyEnabled, next.learningEpoch]);
      return next;
    });
  }
  async completed(owner: string, correctionId: string, inputText: string, correctedText: string, epoch: number): Promise<string | undefined> {
    const id = randomUUID();
    const result = await this.pool.query(`INSERT INTO correction_history(id,owner_id,correction_id,input_text,corrected_text,learning_epoch,status)
      SELECT $1,$2,$3,$4,$5,$6,'pending' FROM correction_preferences
      WHERE owner_id=$2 AND history_enabled AND learning_epoch=$6
      ON CONFLICT(owner_id,correction_id) DO NOTHING RETURNING id`,
      [id, owner, correctionId, inputText, correctedText, epoch]);
    return result.rows[0]?.id;
  }
  async feedback(context: Mutation, correctionId: string, data: CorrectionFeedback): Promise<{ status: string }> {
    return transaction(this.pool, async client => {
      await client.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [context.ownerId]);
      const current = preference((await client.query("SELECT version,history_enabled,learning_epoch FROM correction_preferences WHERE owner_id=$1", [context.ownerId])).rows[0]);
      const result = await client.query<HistoryRow>("SELECT * FROM correction_history WHERE owner_id=$1 AND correction_id=$2 FOR UPDATE", [context.ownerId, correctionId]);
      const row = result.rows[0];
      if (!row) throw missing();
      if (!current.historyEnabled || row.learning_epoch !== current.learningEpoch || row.status === "deleted")
        throw new ServiceError(409, "HISTORY_DISABLED", "这次纠错历史已失效");
      if (row.status === "finalized") {
        if (row.record_id === data.recordId && row.record_version === data.recordVersion && (await client.query(
          "SELECT 1 FROM correction_history WHERE owner_id=$1 AND correction_id=$2 AND save_key=$3", [context.ownerId, correctionId, data.saveKey])).rowCount)
          return { status: "finalized" };
        throw new ServiceError(409, "FEEDBACK_CONFLICT", "这次纠错已关联另一保存版本");
      }
      if (row.created_at.getTime() < Date.now() - 86400_000) throw new ServiceError(410, "HISTORY_EXPIRED", "纠错快照已过期");
      const saved = await client.query<{ body: string }>(`SELECT rr.snapshot->>'body' AS body FROM mutation_requests mr
        JOIN record_revisions rr ON rr.owner_id=mr.owner_id AND rr.request_id=mr.request_id
        WHERE mr.owner_id=$1 AND mr.idempotency_key=$2 AND rr.record_id=$3 AND rr.version=$4
          AND rr.actor='app' AND rr.created_at >= $5
          AND mr.operation IN ('create','edit:' || $3)`, [context.ownerId, data.saveKey, data.recordId, data.recordVersion, row.created_at]);
      if (!saved.rowCount) throw new ServiceError(409, "FEEDBACK_UNVERIFIED", "找不到对应的实际保存版本");
      await client.query(`UPDATE correction_history SET final_text=$3,record_id=$4,record_version=$5,save_key=$6,
        status='finalized',finalized_at=clock_timestamp() WHERE owner_id=$1 AND correction_id=$2`,
        [context.ownerId, correctionId, saved.rows[0]!.body, data.recordId, data.recordVersion, data.saveKey]);
      return { status: "finalized" };
    });
  }
  async list(owner: string, cursor?: string): Promise<CorrectionHistoryPage> {
    let at: string | undefined, id: string | undefined;
    if (cursor) {
      try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (typeof value.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.at)
          || !Number.isFinite(Date.parse(value.at)) || !/^[0-9a-f-]{36}$/.test(value.id)) throw Error();
        at = value.at; id = value.id;
      } catch { throw new ServiceError(400, "INVALID_ARGUMENT", "历史游标无效"); }
    }
    const rows = await this.pool.query<HistoryRow>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM correction_history
      WHERE owner_id=$1 AND status='finalized' AND finalized_at>now()-interval '90 days'
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 21`, [owner, at ?? null, id ?? null]);
    const page = rows.rows.slice(0, 20);
    const last = page.at(-1);
    return { items: page.map(item), nextCursor: rows.rows.length > 20 && last
      ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id })).toString("base64url") : undefined };
  }
  async remove(context: Mutation, id: string) {
    return mutate(this.pool, context, "correction-history-remove", { id }, async client => {
      const result = await client.query(`UPDATE correction_history SET input_text='',corrected_text='',final_text=NULL,
        status='deleted' WHERE owner_id=$1 AND id=$2 AND status='finalized' RETURNING id`, [context.ownerId, id]);
      if (!result.rowCount) throw missing();
      return { ok: true };
    });
  }
  async clear(context: Mutation) {
    return mutate(this.pool, context, "correction-history-clear", {}, async client => {
      await client.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [context.ownerId]);
      await client.query(`INSERT INTO correction_preferences(owner_id,version,learning_epoch)
        VALUES($1,1,1) ON CONFLICT(owner_id) DO UPDATE SET version=correction_preferences.version+1,
        learning_epoch=correction_preferences.learning_epoch+1,updated_at=clock_timestamp()`, [context.ownerId]);
      await client.query(`UPDATE correction_history SET input_text='',corrected_text='',final_text=NULL,status='deleted'
        WHERE owner_id=$1 AND status<>'deleted'`, [context.ownerId]);
      return { ok: true };
    });
  }
  async cleanup() {
    await this.pool.query(`DELETE FROM correction_history WHERE id IN (SELECT id FROM correction_history
      WHERE (status='pending' AND created_at<now()-interval '24 hours')
        OR (status='finalized' AND finalized_at<now()-interval '90 days')
        OR (status='deleted' AND created_at<now()-interval '1 day') LIMIT 200)`);
  }
  async examples(owner: string, text: string, excludeRecordId?: string): Promise<Array<{ from: string; to: string; context: string }>> {
    const result = await this.pool.query<HistoryRow>(`SELECT h.* FROM correction_history h
      JOIN records r ON r.owner_id=h.owner_id AND r.id=h.record_id
      WHERE h.owner_id=$1 AND h.status='finalized' AND h.finalized_at>now()-interval '90 days'
        AND r.deleted_at IS NULL AND r.body=h.final_text AND ($2::uuid IS NULL OR h.record_id<>$2)
      ORDER BY h.finalized_at DESC LIMIT 200`, [owner, excludeRecordId ?? null]);
    const matches: Array<{ from: string; to: string; context: string; score: number }> = [];
    for (const row of result.rows) {
      const diff = localDifference(row.corrected_text, row.final_text!);
      if (!diff) continue;
      if (row.final_text === row.input_text || (row.input_text.includes(diff.to) && !row.input_text.includes(diff.from))) continue;
      const contextMatch = diff.context.length >= 4 && text.includes(diff.context);
      const directMatch = [...diff.from].length >= 3 && text.includes(diff.from);
      const score = contextMatch ? 100 + diff.context.length : directMatch ? 10 + diff.from.length : 0;
      if (score) matches.push({ ...diff, score });
    }
    const seen = new Set<string>();
    return matches.sort((a,b) => b.score-a.score).filter(match => {
      const key = JSON.stringify([match.from, match.to, match.context]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0,3).map(({ from,to,context }) => ({from,to,context}));
  }
  async recordReferences(owner: string, text: string, excludeRecordId?: string): Promise<string[]> {
    const clues = [...new Set((text.match(/[A-Za-z][A-Za-z0-9_-]{3,}|[\p{Script=Han}]{4,}/gu) ?? []).map(s => s.slice(0, 12)))].slice(0, 8);
    if (!clues.length) return [];
    const rows = await this.pool.query<{ body: string }>(`SELECT r.body FROM records r WHERE r.owner_id=$1
      AND r.deleted_at IS NULL AND r.created_via='app' AND r.created_at>now()-interval '30 days' AND ($2::uuid IS NULL OR r.id<>$2)
      AND EXISTS (SELECT 1 FROM record_revisions rr WHERE rr.owner_id=r.owner_id AND rr.record_id=r.id
        AND rr.actor='app' AND rr.snapshot->>'body'=r.body)
      ORDER BY r.updated_at DESC LIMIT 200`, [owner, excludeRecordId ?? null]);
    return rows.rows.map(row => row.body).filter(body => clues.some(c => body.includes(c) && text.includes(c)))
      .slice(0,3).map(body => [...body].slice(0,200).join(""));
  }
}
function localDifference(before: string, after: string): { from: string; to: string; context: string } | undefined {
  const a = [...before], b = [...after]; let start = 0, end = 0;
  while (start < Math.min(a.length,b.length) && a[start] === b[start]) start++;
  while (end < Math.min(a.length-start,b.length-start) && a[a.length-1-end] === b[b.length-1-end]) end++;
  let left = start, rightA = a.length-end, rightB = b.length-end;
  // Preserve an entire Latin name when the minimal edit falls inside it.
  if (/[A-Za-z]/u.test(a.slice(Math.max(0,start-1),rightA+1).join(""))) {
    while (left > 0 && /[A-Za-z0-9_-]/u.test(a[left-1]!)) left--;
    while (rightA < a.length && rightB < b.length && a[rightA] === b[rightB]
      && /[A-Za-z0-9_-]/u.test(a[rightA]!)) { rightA++; rightB++; }
  }
  const from = a.slice(left,rightA).join(""), to = b.slice(left,rightB).join("");
  if (!from || !to || [...from].length > 40 || [...to].length > 40 || /[\d０-９]|(?:不|没|无|未|非|别|勿)/u.test(from+to)
    || /(?:今天|明天|后天|昨天|本周|下周|上周|本月|下月|上月|今年|明年|去年|上线|延期|推迟|提前|增加|减少|取消|需求|计划|同意|拒绝)/u.test(from+to)
    || /[。！？\n]/u.test(from+to) || before.split(from).length !== 2) return;
  const context = a.slice(Math.max(0,left-8),Math.min(a.length,rightA+8)).join("");
  return { from,to,context };
}
