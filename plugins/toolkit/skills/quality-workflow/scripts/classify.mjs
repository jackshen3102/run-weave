import { createHash } from 'node:crypto';
/** Deterministic vocabulary normalization; cross-device wall clocks never calculate durations. */
export function normalize(event) {
  const d = event.details ?? event.context ?? event;
  return { ...event, ...d, client: ({ mac: 'desktop', native: 'ios' })[event.client ?? d.client] ?? event.client ?? d.client,
    launchId: event.launchId ?? d.launchId ?? d.launch_id, operationId: event.operationId ?? event.operationID ?? d.operationId,
    elapsedMs: Number(event.elapsedMs ?? d.elapsedMs), stage: event.stage ?? d.stage };
}
export function classify(input, backendId) {
  const operations = new Map();
  const serverByOperation = new Map();
  for (const raw of input) {
    const event = normalize(raw);
    if (event.client === "backend" && event.action === "terminal_send" && event.stage !== "failed") {
      const key = [event.backendId, event.terminalSessionId, event.operationId].join("|");
      if (!serverByOperation.has(key)) serverByOperation.set(key, []);
      serverByOperation.get(key).push(event);
      continue;
    }
    const key = [event.backendId, event.sourceId, event.launchId, event.action, event.operationId].join('|');
    if (!operations.has(key)) operations.set(key, []);
    operations.get(key).push(event);
  }
  const groups = new Map(); const healthyIds = []; const outcomes = [];
  for (const events of operations.values()) {
    events.sort((a,b) => a.seq - b.seq || a.receiveId - b.receiveId);
    const started = events.find(e => e.stage === 'started'); const confirmed = events.find(e => e.stage === 'confirmed');
    const failed = events.find(e => e.stage === 'failed'); const cancelled = events.find(e => e.stage === 'cancelled');
    const unknown = events.find(e => e.stage === 'unknown'); const rejected = events.find(e => e.stage === 'rejected');
    const last = events.at(-1);
    const serverEvidence = serverByOperation.get([last.backendId,last.terminalSessionId,last.operationId].join("|")) ?? [];
    let classification;
    if (last.action.endsWith('_incident')) classification = 'system_incident';
    else if (last.action === 'connection_recover') classification = confirmed ? failed ? 'established_then_lost' : cancelled ? 'established_then_cancelled' : 'established' : failed ? 'failed_before_established' : cancelled ? 'cancelled' : 'incomplete';
    else classification = confirmed ? failed ? 'accepted_with_failure' : unknown ? 'accepted_with_unknown' : 'input_accepted' : unknown ? 'outcome_unknown' : failed ? 'request_failed' : rejected ? 'locally_rejected' : cancelled ? 'cancelled' : 'incomplete';
    const incomplete = !started || !confirmed && !failed && !cancelled && !rejected && !unknown;
    outcomes.push({ operationId:last.operationId, action:last.action, classification, incomplete, evidenceIds:events.map(event=>event.receiveId), establishmentMs:started&&confirmed?confirmed.elapsedMs:null, connectionLifetimeMs:confirmed&&failed&&failed.elapsedMs>=confirmed.elapsedMs?failed.elapsedMs-confirmed.elapsedMs:null });
    if (!incomplete && ['established', 'established_then_cancelled', 'input_accepted', 'cancelled'].includes(classification)) { healthyIds.push(...events.map(e => e.receiveId)); continue; }
    const signal = failed ?? unknown ?? rejected ?? last;
    // A candidate group is a triage aid, never proof of a common root cause.
    const groupKey = [backendId, signal.projectId ?? 'unassigned', signal.action, classification, signal.failureCode ?? 'unknown', signal.sourceRevision, signal.buildId].join('|');
    const issueId = 'qwf-' + createHash('sha256').update(groupKey).digest('hex').slice(0,24);
    const item = groups.get(groupKey) ?? { issueId, groupKey, classification, incomplete, evidence: [], operations: [], sourceLimit: signal.sourceState !== 'clean' || signal.sourceRevision === 'unknown' };
    item.incomplete ||= incomplete; item.evidence.push(...events, ...serverEvidence); item.operations.push({ operationId: last.operationId, classification, incomplete,
      establishmentMs: confirmed?.elapsedMs ?? null,
      connectionLifetimeMs: confirmed && failed && failed.elapsedMs >= confirmed.elapsedMs ? failed.elapsedMs - confirmed.elapsedMs : null,
      accepted: Boolean(confirmed), stateSubmitted: events.some(e => e.stage === 'state_updated'), uiLifecycle: events.some(e => e.stage === 'ui_updated') });
    groups.set(groupKey,item);
  }
  // Successful server boundary records are corroboration, not incomplete client failures.
  for (const events of serverByOperation.values()) healthyIds.push(...events.map(e=>e.receiveId));
  return { outcomes, groups: [...groups.values()].sort((a,b) => Number(b.classification === 'system_incident') - Number(a.classification === 'system_incident') || a.evidence[0].receiveId - b.evidence[0].receiveId), healthyIds };
}
