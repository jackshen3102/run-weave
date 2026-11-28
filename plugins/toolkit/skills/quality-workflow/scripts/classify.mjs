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

export function compareVersions(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return null;
  if (left === right) return 0;
  const parse = value => {
    const core = value.trim().replace(/^v/i, '').split(/[-+]/)[0];
    if (!/^\d+(?:\.\d+)*$/.test(core)) return null;
    return core.split('.').map(Number);
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) return null;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0; const bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

export function detectLatencyRegressions(buckets, existingIssues = [], backendId = 'unknown') {
  const byStream = new Map();
  for (const bucket of buckets ?? []) {
    if (!['desktop', 'web', 'ios'].includes(bucket.client)) continue;
    if (bucket.sourceState !== 'clean' || Number(bucket.count) < 20) continue;
    if (!Array.isArray(bucket.sampleEvidenceIds) || !bucket.sampleEvidenceIds.length) continue;
    const key = `${bucket.client}|${bucket.action}`;
    if (!byStream.has(key)) byStream.set(key, []);
    byStream.get(key).push(bucket);
  }
  const regressions = [];
  for (const list of byStream.values()) {
    list.sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.lastAt.localeCompare(b.lastAt));
    const curr = list.at(-1);
    const prev = [...list.slice(0, -1)].reverse().find(item => item.buildId !== curr.buildId);
    if (!prev) continue;
    if (curr.p90Ms < Math.ceil(prev.p90Ms * 1.5) || curr.p90Ms - prev.p90Ms < 300) continue;
    const groupKey = [backendId, 'unassigned', curr.action, 'latency_regression', 'P90_REGRESSION', curr.sourceRevision, curr.buildId].join('|');
    const existing = existingIssues.find(issue => issue.groupKey === groupKey || issue.groupKey.startsWith(groupKey + '|'));
    if (existing && curr.sampleEvidenceIds.every(id => existing.evidenceIds?.includes(id))) continue;
    const issueId = 'qwf-' + createHash('sha256').update(groupKey).digest('hex').slice(0, 24);
    regressions.push({
      issueId,
      groupKey,
      classification: 'latency_regression',
      incomplete: false,
      sourceLimit: false,
      baselineSummary: {
        client: curr.client,
        action: curr.action,
        baseline: { appVersion: prev.appVersion, buildId: prev.buildId, sourceRevision: prev.sourceRevision, count: prev.count, p50Ms: prev.p50Ms, p90Ms: prev.p90Ms, maxMs: prev.maxMs },
        current: { appVersion: curr.appVersion, buildId: curr.buildId, sourceRevision: curr.sourceRevision, count: curr.count, p50Ms: curr.p50Ms, p90Ms: curr.p90Ms, maxMs: curr.maxMs },
        deltaP90Ms: curr.p90Ms - prev.p90Ms,
        ratioP90: Number((curr.p90Ms / Math.max(1, prev.p90Ms)).toFixed(2)),
      },
      evidence: curr.sampleEvidenceIds.map(receiveId => ({
        receiveId,
        client: curr.client,
        action: curr.action,
        stage: 'confirmed',
        elapsedMs: curr.p90Ms,
        appVersion: curr.appVersion,
        buildId: curr.buildId,
        sourceRevision: curr.sourceRevision,
        sourceState: curr.sourceState,
        at: curr.lastAt,
      })),
      operations: [],
    });
  }
  return regressions;
}

export function buildPostFixSummary(issue, buckets = [], activeGroups = []) {
  if (!issue?.fixVersion) return null;
  const parts = String(issue.groupKey ?? '').split('|');
  const action = parts[2] ?? '';
  const classification = parts[3] ?? '';
  const failureCode = parts[4] ?? '';
  const isPostFix = item => {
    const cmp = compareVersions(item.appVersion, issue.fixVersion);
    return (cmp !== null && cmp >= 0) || item.buildId === issue.fixVersion || item.sourceRevision === issue.fixVersion;
  };
  const matchingBuckets = (buckets ?? []).filter(b => (!action || action.endsWith('_incident') || b.action === action) && isPostFix(b));
  const postFixHealthyCount = matchingBuckets.reduce((sum, b) => sum + Number(b.count ?? 0), 0);
  const postFixVersions = [...new Set(matchingBuckets.map(b => b.appVersion))];
  const postFixSampleEvidenceIds = [...new Set(matchingBuckets.flatMap(b => b.sampleEvidenceIds ?? []))].slice(0, 5);
  const recurringGroupCount = (activeGroups ?? []).filter(group => {
    const gp = String(group.groupKey ?? '').split('|');
    if (gp[2] !== action || gp[3] !== classification || gp[4] !== failureCode) return false;
    return (group.evidence ?? []).some(isPostFix);
  }).length;
  return {
    fixVersion: issue.fixVersion,
    hasPostFixUsage: postFixHealthyCount > 0,
    postFixHealthyCount,
    postFixVersions,
    postFixSampleEvidenceIds,
    recurringGroupCount,
    readyForAwaitingConfirmation: postFixHealthyCount > 0 && recurringGroupCount === 0,
  };
}
