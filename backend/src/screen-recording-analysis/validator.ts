import type { AnalysisManifest, AnalysisResult } from '@runweave/shared/screen-recording';

const nullableString = { type: ['string', 'null'] };
export const analysisResultSchema = {
  type: 'object', additionalProperties: false, required: ['cards','observation','rewriteSpan','replacements'], properties: {
    observation: { type: 'string', maxLength: 4000 },
    rewriteSpan: { anyOf: [{ type: 'null' }, { type: 'object',additionalProperties: false,required: ['startMs','endMs'],properties: { startMs: { type: 'integer' },endMs: { type: 'integer' } } }] },
    replacements: { type: 'array',maxItems: 32,items: { type: 'object',additionalProperties: false,required: ['cardID','baseRevision','targetIndexes'],properties: { cardID: { type: 'string' },baseRevision: { type: 'integer' },targetIndexes: { type: 'array',minItems: 1,maxItems: 32,items: { type: 'integer',minimum: 0,maximum: 31 } } } } },
    cards: { type: 'array', maxItems: 32, items: {
      type: 'object', additionalProperties: false,
      required: ['cardID','matterID','baseRevision','title','summary','detail','actor','state','projectID','spans','evidenceIDs'],
      properties: {
        cardID: nullableString, matterID: nullableString, baseRevision: { type: ['integer','null'] },
        title: { type: 'string', minLength: 1, maxLength: 200 }, summary: { type: 'string', maxLength: 2000 }, detail: { type: 'string', maxLength: 8000 },
        actor: { enum: ['person','agent','mixed'] }, state: { enum: ['discussed','attempted','progress','agent-reported','verified','documented'] }, projectID: nullableString,
        spans: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['startMs','endMs','actor'], properties: { startMs: { type: 'integer' }, endMs: { type: 'integer' }, actor: { enum: ['person','agent','mixed'] } } } },
        evidenceIDs: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    } },
  },
};
function exactObject(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error('INVALID_RESULT');
}
export function validateResult(value: unknown, manifest: AnalysisManifest): AnalysisResult {
  exactObject(value,['cards','observation',...Object.keys(value ?? {}).filter(key => ['rewriteSpan','replacements'].includes(key))]);
  const result = value as AnalysisResult;
  if (!Array.isArray(result.cards) || result.cards.length > 32 || typeof result.observation !== 'string' || result.observation.length > 4000) throw new Error('INVALID_RESULT');
  const replacements = result.replacements ?? [];
  if (!Array.isArray(replacements) || replacements.length > 32 || Boolean(result.rewriteSpan) !== Boolean(replacements.length)) throw new Error('INVALID_REWRITE');
  const replaced = new Set<string>();
  for (const item of replacements) {
    exactObject(item,['cardID','baseRevision','targetIndexes']);
    const old = manifest.context.find(card => card.cardID === item.cardID);
    if (!old || old.revision !== item.baseRevision || replaced.has(item.cardID) || !Array.isArray(item.targetIndexes) || !item.targetIndexes.length || item.targetIndexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= result.cards.length)) throw new Error('INVALID_REWRITE');
    replaced.add(item.cardID);
  }
  const rewrite = result.rewriteSpan;
  if (rewrite) {
    exactObject(rewrite,['startMs','endMs']);
    if (!Number.isSafeInteger(rewrite.startMs) || !Number.isSafeInteger(rewrite.endMs) || rewrite.startMs < manifest.startMs-2700000 || rewrite.endMs > manifest.endMs || rewrite.startMs > rewrite.endMs || manifest.context.filter(c => replaced.has(c.cardID)).some(c => c.spans.some(s => s.startMs < rewrite.startMs || s.endMs > rewrite.endMs))) throw new Error('INVALID_REWRITE');
  }
  const evidence = new Map(manifest.evidence.map(item => [item.id,item]));
  const historicalSpans = manifest.context.filter(card => replaced.has(card.cardID)).flatMap(card => card.spans);
  const spans: Array<{ startMs: number; endMs: number }> = manifest.context.filter(card => !replaced.has(card.cardID)).flatMap(card => card.spans).filter(span => span.actor !== 'agent');
  for (const card of result.cards) {
    exactObject(card,['cardID','matterID','baseRevision','title','summary','detail','actor','state','projectID','spans','evidenceIDs']);
    for (const id of [card.cardID,card.matterID,card.projectID]) if (id !== null && (typeof id !== 'string' || id.length > 256)) throw new Error('INVALID_IDENTITY');
    if (card.baseRevision !== null && (!Number.isSafeInteger(card.baseRevision) || card.baseRevision < 1)) throw new Error('INVALID_IDENTITY');
    if (!card || typeof card.title !== 'string' || !card.title || card.title.length > 200 || typeof card.summary !== 'string' || card.summary.length > 2000 || typeof card.detail !== 'string' || card.detail.length > 8000 || !['person','agent','mixed'].includes(card.actor) || !['discussed','attempted','progress','agent-reported','verified','documented'].includes(card.state)) throw new Error('INVALID_RESULT');
    if (!Array.isArray(card.evidenceIDs) || !card.evidenceIDs.length || card.evidenceIDs.some(id => !evidence.has(id))) throw new Error('UNKNOWN_EVIDENCE');
    const refs = card.evidenceIDs.map(id => evidence.get(id)!);
    if (refs.every(item => item.source === 'agent') && card.actor !== 'agent') throw new Error('UNSUPPORTED_CONCLUSION');
    const screenOnly = refs.every(item => item.source === 'screen');
    if (screenOnly && (!['documented','discussed'].includes(card.state) || card.actor !== 'person')) throw new Error('UNSUPPORTED_CONCLUSION');
    if (card.state === 'verified' && !refs.some(item => item.source === 'agent' && item.kind === 'tool' && item.independentSuccess === true)) throw new Error('UNVERIFIED_CONCLUSION');
    if (card.cardID !== null) {
      const old = manifest.context.find(item => item.cardID === card.cardID);
      if (!old || old.matterID !== card.matterID || old.revision !== card.baseRevision) throw new Error('CONFLICT');
    } else if (card.baseRevision !== null || (card.matterID !== null && !manifest.context.some(old => old.matterID === card.matterID))) throw new Error('INVALID_IDENTITY');
    if (!Array.isArray(card.spans) || card.spans.length === 0 || card.spans.length > 32) throw new Error('INVALID_SPAN');
    for (const span of card.spans) {
      exactObject(span,['startMs','endMs','actor']);
      if (!Number.isSafeInteger(span.startMs) || !Number.isSafeInteger(span.endMs) || span.startMs < (rewrite?.startMs ?? manifest.startMs) || span.endMs > manifest.endMs || span.startMs > span.endMs || span.actor !== card.actor) throw new Error('INVALID_SPAN');
      if (span.startMs < manifest.startMs && !historicalSpans.some(old => old.actor === span.actor && old.startMs <= span.startMs && old.endMs >= Math.min(span.endMs,manifest.startMs))) throw new Error('INVALID_REWRITE');
      if (span.actor !== 'agent') {
        if (manifest.intervals.some(gap => gap.startMs < span.endMs && gap.endMs > span.startMs) || spans.some(old => old.startMs < span.endMs && old.endMs > span.startMs)) throw new Error('OVERLAPPING_COVERAGE');
        spans.push(span);
      }
    }
  }
  return result;
}
