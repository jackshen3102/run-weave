import type pg from "pg";
import type { ImportWorkFacts, MaterialInput, MaterialMetadata, MaterialResult } from "@runweave/shared/suiji";
import { invalid, ServiceError } from "../errors";
import { getRecord } from "../records/repository";

export function validateMaterial(kind: string, input: MaterialInput | null | undefined, old?: MaterialMetadata | null) {
  if (!input) return;
  if (kind !== "note") throw invalid("请先将素材转为想法，再转为待办");
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (input.materialDate > today) throw invalid("素材归属日期不能晚于今天");
  if (old && (input.captureId !== old.captureId || Date.parse(input.capturedAt) !== Date.parse(old.capturedAt)))
    throw invalid("素材采集身份和采集时间不可修改");
  if (input.inputType === "link" && !input.sourceUrl) throw invalid("链接素材需要 HTTP(S) 地址");
}

export function materialValue(input: MaterialInput): MaterialInput {
  return { captureId: input.captureId, capturedAt: new Date(input.capturedAt).toISOString(),
    materialDate: input.materialDate, inputType: input.inputType,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}) };
}

export async function saveMaterial(client: pg.PoolClient, owner: string, id: string, input: MaterialInput | null, old?: MaterialMetadata | null) {
  if (!input) {
    await client.query("DELETE FROM record_materials WHERE owner_id=$1 AND record_id=$2", [owner, id]);
    return;
  }
  if (!old) {
    const claim = await client.query("INSERT INTO material_captures(owner_id,capture_id,record_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING capture_id", [owner, input.captureId, id]);
    if (!claim.rowCount) throw new ServiceError(409, "INVALID_ARGUMENT", "该采集身份已保存；请使用原请求确认结果");
  }
  await client.query(`INSERT INTO record_materials(owner_id,record_id,capture_id,captured_at,material_date,input_type,source_url)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,record_id) DO UPDATE
    SET material_date=excluded.material_date,input_type=excluded.input_type,source_url=excluded.source_url`,
  [owner, id, input.captureId, input.capturedAt, input.materialDate, input.inputType, input.sourceUrl ?? null]);
}

/** Lock content before importing facts; stale reads abort the whole import. */
export async function lockMaterials(client: pg.PoolClient, owner: string, results: MaterialResult[] = []) {
  for (const item of [...results].sort((a, b) => a.recordId.localeCompare(b.recordId))) {
    const record = await getRecord(client, owner, item.recordId, true);
    if (!record.material || record.version !== item.recordVersion || record.material.sourceHash !== item.sourceHash)
      throw new ServiceError(409, "VERSION_CONFLICT", "素材已变化，请重新读取后整理", { recordId: item.recordId });
  }
}

export async function confirmMaterials(client: pg.PoolClient, owner: string, importId: string, input: ImportWorkFacts) {
  const serverId = (await client.query("SELECT server_id FROM server_identity")).rows[0].server_id;
  const scope = `materials:${serverId}:${owner}`;
  for (const item of input.materialResults ?? []) {
    const record = await getRecord(client, owner, item.recordId);
    const day = input.days.find(day => day.date === record.material?.materialDate);
    if (!day?.requestedScopes.includes(scope) || !day.receipts.some(r => r.sourceScope === scope && r.status !== "unavailable"))
      throw invalid("素材回执必须属于本次实际读取的归属日期和账号范围");
    for (const eventKey of item.eventKeys) {
      const facts = (await client.query("SELECT source_snapshot FROM work_facts WHERE owner_id=$1 AND event_key=$2", [owner, eventKey])).rows;
      if (!facts.some(row => row.source_snapshot?.sourceRefs?.some((ref: { channel: string; sourceScope: string; nativeId: string; revision?: string; hash?: string }) =>
        ref.channel === "suiji-material" && ref.sourceScope === scope && ref.nativeId === item.recordId && ref.revision === String(item.recordVersion) && ref.hash === item.sourceHash)))
        throw invalid("整理结果必须关联包含当前素材依据的同账号事实");
    }
    await client.query(`INSERT INTO material_results(owner_id,record_id,record_version,source_hash,outcome,event_keys,import_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,record_id,record_version) DO NOTHING`,
    [owner, item.recordId, item.recordVersion, item.sourceHash, item.outcome, JSON.stringify(item.eventKeys), importId]);
    await client.query(`UPDATE record_materials SET processed_version=$3,processed_at=(SELECT processed_at FROM material_results
      WHERE owner_id=$1 AND record_id=$2 AND record_version=$3) WHERE owner_id=$1 AND record_id=$2`, [owner, item.recordId, item.recordVersion]);
  }
}

/** Immutable receipt remains readable when a later edit removes the category. */
export async function materialReceipt(client: Pick<pg.Pool, "query">, owner: string, id: string, version: number) {
  const row = (await client.query(`SELECT record_id AS "recordId",record_version AS "recordVersion",source_hash AS "sourceHash",
    outcome,event_keys AS "eventKeys",processed_at AS "processedAt" FROM material_results
    WHERE owner_id=$1 AND record_id=$2 AND record_version=$3`, [owner, id, version])).rows[0];
  if (!row) throw new ServiceError(404, "NOT_FOUND", "未找到该版本的素材处理回执");
  return row;
}
