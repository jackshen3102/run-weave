import type {
  ContextPackManifest,
  DataQualityIssue,
} from "@runweave/shared/evolution";

const PAYLOAD_DIMENSION_KEYS = new Set([
  "exitCode",
  "hookEvent",
  "phase",
  "purpose",
  "reasonCode",
  "status",
  "toolName",
]);
const MAX_SUMMARY_GROUPS = 100;
const MAX_GROUP_EVIDENCE_IDS = 3;

export function summarizeDataQuality(issues: DataQualityIssue[]): {
  issueCount: number;
  groups: Array<{
    source: DataQualityIssue["source"];
    code: string;
    severity: DataQualityIssue["severity"];
    count: number;
    detail: string;
    sampleEvidenceIds: string[];
  }>;
  omittedGroupCount: number;
} {
  const groups = new Map<
    string,
    {
      source: DataQualityIssue["source"];
      code: string;
      severity: DataQualityIssue["severity"];
      count: number;
      detail: string;
      sampleEvidenceIds: string[];
    }
  >();
  for (const issue of issues) {
    const key = `${issue.source}\0${issue.code}\0${issue.severity}`;
    const group = groups.get(key) ?? {
      source: issue.source,
      code: issue.code,
      severity: issue.severity,
      count: 0,
      detail: issue.detail,
      sampleEvidenceIds: [],
    };
    group.count += 1;
    appendSamples(group.sampleEvidenceIds, issue.evidenceIds);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.source.localeCompare(right.source) ||
      left.code.localeCompare(right.code),
  );
  return {
    issueCount: issues.length,
    groups: ordered.slice(0, MAX_SUMMARY_GROUPS),
    omittedGroupCount: Math.max(0, ordered.length - MAX_SUMMARY_GROUPS),
  };
}

export function summarizeActivityFacts(manifest: ContextPackManifest): {
  coverage: {
    recordCount: number;
    summarizedCount: number;
    unclassifiedCount: number;
    fullyCovered: boolean;
    afterWatermark: string | null;
    snapshotBoundary: string | null;
    earliestOccurredAt: string | null;
    latestOccurredAt: string | null;
    projectCount: number;
    workspaceCount: number;
  };
  outcomes: Array<{ status: string; count: number }>;
  eventTypes: Array<{
    eventName: string;
    count: number;
    failedCount: number;
    workspaceCount: number;
    firstOccurredAt: string;
    lastOccurredAt: string;
    firstEvidenceIds: string[];
    lastEvidenceIds: string[];
  }>;
  failureCodes: Array<{
    code: string;
    count: number;
    sampleEvidenceIds: string[];
  }>;
  payloadDimensions: Array<{
    key: string;
    value: string;
    count: number;
    sampleEvidenceIds: string[];
  }>;
  workspaces: {
    items: Array<{
      workspace: string;
      projectId: string | null;
      count: number;
      failedCount: number;
      topEventTypes: Array<{ eventName: string; count: number }>;
      sampleEvidenceIds: string[];
    }>;
    omittedCount: number;
  };
} {
  const source = manifest.sources.find((item) => item.source === "activity");
  const evidence = manifest.evidence.filter(
    (item) => item.source === "activity",
  );
  const projects = new Set<string>();
  const workspaces = new Map<
    string,
    {
      workspace: string;
      projectId: string | null;
      count: number;
      failedCount: number;
      eventTypes: Map<string, number>;
      sampleEvidenceIds: string[];
    }
  >();
  const eventTypes = new Map<
    string,
    {
      eventName: string;
      count: number;
      failedCount: number;
      workspaces: Set<string>;
      firstOccurredAt: string;
      lastOccurredAt: string;
      firstEvidenceIds: string[];
      lastEvidenceIds: string[];
    }
  >();
  const outcomes = new Map<string, number>();
  const failureCodes = new Map<
    string,
    { code: string; count: number; sampleEvidenceIds: string[] }
  >();
  const payloadDimensions = new Map<
    string,
    { key: string; value: string; count: number; sampleEvidenceIds: string[] }
  >();
  let summarizedCount = 0;
  let earliestOccurredAt: string | null = null;
  let latestOccurredAt: string | null = null;

  for (const item of evidence) {
    const activity = item.activity;
    if (!activity) continue;
    summarizedCount += 1;
    earliestOccurredAt = earlierTimestamp(
      earliestOccurredAt,
      activity.occurredAt,
    );
    latestOccurredAt = laterTimestamp(latestOccurredAt, activity.occurredAt);
    if (item.origin.projectId) projects.add(item.origin.projectId);
    const workspaceKey =
      item.origin.path ?? item.origin.projectId ?? "(unknown workspace)";
    const workspace = workspaces.get(workspaceKey) ?? {
      workspace: workspaceKey,
      projectId: item.origin.projectId,
      count: 0,
      failedCount: 0,
      eventTypes: new Map<string, number>(),
      sampleEvidenceIds: [],
    };
    workspace.count += 1;
    if (activity.resultStatus === "failed") workspace.failedCount += 1;
    workspace.eventTypes.set(
      activity.eventName,
      (workspace.eventTypes.get(activity.eventName) ?? 0) + 1,
    );
    appendSamples(workspace.sampleEvidenceIds, [item.evidenceId]);
    workspaces.set(workspaceKey, workspace);

    const eventType = eventTypes.get(activity.eventName) ?? {
      eventName: activity.eventName,
      count: 0,
      failedCount: 0,
      workspaces: new Set<string>(),
      firstOccurredAt: activity.occurredAt,
      lastOccurredAt: activity.occurredAt,
      firstEvidenceIds: [],
      lastEvidenceIds: [],
    };
    eventType.count += 1;
    if (activity.resultStatus === "failed") eventType.failedCount += 1;
    eventType.workspaces.add(workspaceKey);
    if (activity.occurredAt < eventType.firstOccurredAt) {
      eventType.firstOccurredAt = activity.occurredAt;
    }
    if (activity.occurredAt > eventType.lastOccurredAt) {
      eventType.lastOccurredAt = activity.occurredAt;
    }
    appendSamples(eventType.firstEvidenceIds, [item.evidenceId]);
    appendLatestSamples(eventType.lastEvidenceIds, item.evidenceId);
    eventTypes.set(activity.eventName, eventType);

    const outcome = activity.resultStatus ?? "not_recorded";
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    if (activity.resultStatus === "failed" && activity.resultCode) {
      const failure = failureCodes.get(activity.resultCode) ?? {
        code: activity.resultCode,
        count: 0,
        sampleEvidenceIds: [],
      };
      failure.count += 1;
      appendSamples(failure.sampleEvidenceIds, [item.evidenceId]);
      failureCodes.set(activity.resultCode, failure);
    }
    for (const [key, value] of Object.entries(activity.payload)) {
      if (!PAYLOAD_DIMENSION_KEYS.has(key)) continue;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        continue;
      }
      const normalizedValue = String(value).slice(0, 160);
      const dimensionKey = `${key}\0${normalizedValue}`;
      const dimension = payloadDimensions.get(dimensionKey) ?? {
        key,
        value: normalizedValue,
        count: 0,
        sampleEvidenceIds: [],
      };
      dimension.count += 1;
      appendSamples(dimension.sampleEvidenceIds, [item.evidenceId]);
      payloadDimensions.set(dimensionKey, dimension);
    }
  }

  const workspaceItems = [...workspaces.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.workspace.localeCompare(right.workspace),
    )
    .map((workspace) => ({
      workspace: workspace.workspace,
      projectId: workspace.projectId,
      count: workspace.count,
      failedCount: workspace.failedCount,
      topEventTypes: [...workspace.eventTypes.entries()]
        .map(([eventName, count]) => ({ eventName, count }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            left.eventName.localeCompare(right.eventName),
        )
        .slice(0, 5),
      sampleEvidenceIds: workspace.sampleEvidenceIds,
    }));
  return {
    coverage: {
      recordCount: source?.recordCount ?? evidence.length,
      summarizedCount,
      unclassifiedCount: evidence.length - summarizedCount,
      fullyCovered:
        source?.truncated === false &&
        (source.recordCount ?? evidence.length) === evidence.length &&
        summarizedCount === evidence.length,
      afterWatermark: source?.afterWatermark ?? null,
      snapshotBoundary: source?.snapshotBoundary ?? null,
      earliestOccurredAt,
      latestOccurredAt,
      projectCount: projects.size,
      workspaceCount: workspaces.size,
    },
    outcomes: [...outcomes.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.status.localeCompare(right.status),
      ),
    eventTypes: [...eventTypes.values()]
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.eventName.localeCompare(right.eventName),
      )
      .map((eventType) => ({
        eventName: eventType.eventName,
        count: eventType.count,
        failedCount: eventType.failedCount,
        workspaceCount: eventType.workspaces.size,
        firstOccurredAt: eventType.firstOccurredAt,
        lastOccurredAt: eventType.lastOccurredAt,
        firstEvidenceIds: eventType.firstEvidenceIds,
        lastEvidenceIds: eventType.lastEvidenceIds,
      })),
    failureCodes: [...failureCodes.values()]
      .sort(
        (left, right) =>
          right.count - left.count || left.code.localeCompare(right.code),
      )
      .slice(0, MAX_SUMMARY_GROUPS),
    payloadDimensions: [...payloadDimensions.values()]
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.key.localeCompare(right.key) ||
          left.value.localeCompare(right.value),
      )
      .slice(0, MAX_SUMMARY_GROUPS),
    workspaces: {
      items: workspaceItems.slice(0, MAX_SUMMARY_GROUPS),
      omittedCount: Math.max(0, workspaceItems.length - MAX_SUMMARY_GROUPS),
    },
  };
}

function appendSamples(target: string[], candidates: string[]): void {
  for (const candidate of candidates) {
    if (target.length < MAX_GROUP_EVIDENCE_IDS && !target.includes(candidate)) {
      target.push(candidate);
    }
  }
}

function appendLatestSamples(target: string[], candidate: string): void {
  const existing = target.indexOf(candidate);
  if (existing >= 0) target.splice(existing, 1);
  target.push(candidate);
  if (target.length > MAX_GROUP_EVIDENCE_IDS) target.shift();
}

function earlierTimestamp(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function laterTimestamp(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}
