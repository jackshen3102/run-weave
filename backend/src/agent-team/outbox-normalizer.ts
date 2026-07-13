import type {
  AgentTeamAcceptanceEvidence,
  AgentTeamFindingSeverity,
  AgentTeamFindingStatus,
  AgentTeamFixCheckDimension,
  AgentTeamFixReproductionMode,
  AgentTeamFixReproductionStatus,
  AgentTeamFixVerification,
  AgentTeamOutboxFinding,
  AgentTeamOutboxRecommendation,
} from "@runweave/shared/agent-team";

const VALID_EVIDENCE_TYPES = new Set<AgentTeamAcceptanceEvidence["type"]>([
  "screenshot",
  "dom",
  "text",
  "command",
  "event",
  "json",
  "log",
  "code",
]);
const VALID_FINDING_SEVERITIES = new Set<AgentTeamFindingSeverity>([
  "P0",
  "P1",
  "P2",
  "P3",
]);
const VALID_FINDING_STATUSES = new Set<AgentTeamFindingStatus>([
  "open",
  "resolved",
  "informational",
]);
const VALID_REPRODUCTION_MODES = new Set<AgentTeamFixReproductionMode>([
  "real_product",
  "review_harness",
  "static_contract",
]);
const VALID_REPRODUCTION_STATUSES = new Set<AgentTeamFixReproductionStatus>([
  "reproduced",
  "confirmed",
  "not_reproduced",
  "boundary",
  "blocked",
]);
const VALID_CHECK_DIMENSIONS = new Set<AgentTeamFixCheckDimension>([
  "positive",
  "negative",
  "temporal",
  "concurrent",
  "regression",
]);

export function normalizeFindings(
  findings: unknown,
  defaultStatus: AgentTeamFindingStatus,
): AgentTeamOutboxFinding[] | undefined {
  if (!Array.isArray(findings)) {
    return undefined;
  }
  const normalized = findings
    .map((finding) => normalizeFinding(finding, defaultStatus))
    .filter((finding): finding is AgentTeamOutboxFinding => Boolean(finding));
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeRecommendations(
  recommendations: unknown,
): AgentTeamOutboxRecommendation[] | undefined {
  if (!Array.isArray(recommendations)) {
    return undefined;
  }
  const normalized = recommendations
    .map(normalizeRecommendation)
    .filter((item): item is AgentTeamOutboxRecommendation => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFinding(
  finding: unknown,
  defaultStatus: AgentTeamFindingStatus,
): AgentTeamOutboxFinding | null {
  if (!finding || typeof finding !== "object") {
    return null;
  }
  const record = finding as Record<string, unknown>;
  const severity = normalizeSeverity(record.severity);
  const title =
    typeof record.title === "string"
      ? record.title.trim()
      : typeof record.summary === "string"
        ? record.summary.trim().slice(0, 120)
        : "";
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  if (!severity || !title || !summary) {
    return null;
  }
  const rawStatus =
    typeof record.status === "string" ? record.status.trim() : defaultStatus;
  const status = VALID_FINDING_STATUSES.has(rawStatus as AgentTeamFindingStatus)
    ? (rawStatus as AgentTeamFindingStatus)
    : defaultStatus;
  return {
    severity,
    status,
    title,
    summary,
    ...(typeof record.ref === "string" && record.ref.trim()
      ? { ref: record.ref.trim() }
      : {}),
    ...(typeof record.invariantKey === "string" && record.invariantKey.trim()
      ? { invariantKey: record.invariantKey.trim() }
      : {}),
    ...(record.verificationMode === "runtime" ||
    record.verificationMode === "structural"
      ? { verificationMode: record.verificationMode }
      : {}),
  };
}

export function normalizeFixVerifications(
  value: unknown,
): AgentTeamFixVerification[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map(normalizeFixVerification)
    .filter((item): item is AgentTeamFixVerification => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFixVerification(
  value: unknown,
): AgentTeamFixVerification | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const repairKey =
    typeof record.repairKey === "string" ? record.repairKey.trim() : "";
  const invariant =
    typeof record.invariant === "string" ? record.invariant.trim() : "";
  if (!repairKey || !invariant) {
    return null;
  }
  const reproduction = normalizeReproduction(record.reproduction);
  const verification = normalizeVerification(record.verification);
  if (!reproduction || !verification) {
    return null;
  }
  const impactedChecks = Array.isArray(record.impactedChecks)
    ? record.impactedChecks
        .map(normalizeImpactedCheck)
        .filter(
          (item): item is AgentTeamFixVerification["impactedChecks"][number] =>
            Boolean(item),
        )
    : [];
  return {
    repairKey,
    invariant,
    reproduction,
    verification,
    impactedChecks,
    ...(typeof record.strategyAssessment === "string" &&
    record.strategyAssessment.trim()
      ? { strategyAssessment: record.strategyAssessment.trim() }
      : {}),
  };
}

function normalizeReproduction(
  value: unknown,
): AgentTeamFixVerification["reproduction"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !VALID_REPRODUCTION_MODES.has(
      record.mode as AgentTeamFixReproductionMode,
    ) ||
    !VALID_REPRODUCTION_STATUSES.has(
      record.status as AgentTeamFixReproductionStatus,
    )
  ) {
    return null;
  }
  return {
    mode: record.mode as AgentTeamFixReproductionMode,
    status: record.status as AgentTeamFixReproductionStatus,
    ...(typeof record.scenarioId === "string" && record.scenarioId.trim()
      ? { scenarioId: record.scenarioId.trim() }
      : {}),
    ...(typeof record.validationSessionId === "string" &&
    record.validationSessionId.trim()
      ? { validationSessionId: record.validationSessionId.trim() }
      : {}),
    evidence: normalizeEvidenceList(record.evidence),
  };
}

function normalizeVerification(
  value: unknown,
): AgentTeamFixVerification["verification"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status !== "pass" &&
    record.status !== "fail" &&
    record.status !== "blocked"
  ) {
    return null;
  }
  return {
    status: record.status,
    sameScenario: record.sameScenario === true,
    evidence: normalizeEvidenceList(record.evidence),
  };
}

function normalizeImpactedCheck(
  value: unknown,
): AgentTeamFixVerification["impactedChecks"][number] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  if (
    !label ||
    !summary ||
    !VALID_CHECK_DIMENSIONS.has(
      record.dimension as AgentTeamFixCheckDimension,
    ) ||
    (record.status !== "pass" &&
      record.status !== "fail" &&
      record.status !== "skipped")
  ) {
    return null;
  }
  return {
    label,
    summary,
    dimension: record.dimension as AgentTeamFixCheckDimension,
    status: record.status,
    evidence: normalizeEvidenceList(record.evidence),
  };
}

export function normalizeEvidenceList(
  value: unknown,
): AgentTeamAcceptanceEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (evidence): evidence is AgentTeamAcceptanceEvidence =>
        Boolean(evidence) &&
        typeof evidence === "object" &&
        VALID_EVIDENCE_TYPES.has(evidence.type) &&
        typeof evidence.ref === "string" &&
        Boolean(evidence.ref.trim()) &&
        typeof evidence.label === "string" &&
        Boolean(evidence.label.trim()) &&
        typeof evidence.summary === "string" &&
        Boolean(evidence.summary.trim()),
    )
    .map((evidence) => ({
      type: evidence.type,
      label: evidence.label.trim(),
      summary: evidence.summary.trim(),
      ...(typeof evidence.detail === "string" && evidence.detail.trim()
        ? { detail: evidence.detail.trim() }
        : {}),
      ref: evidence.ref.trim(),
    }));
}

function normalizeRecommendation(
  recommendation: unknown,
): AgentTeamOutboxRecommendation | null {
  if (!recommendation || typeof recommendation !== "object") {
    return null;
  }
  const record = recommendation as Record<string, unknown>;
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return null;
  }
  const severity = normalizeSeverity(record.severity);
  return {
    ...(severity ? { severity } : {}),
    summary,
  };
}

function normalizeSeverity(value: unknown): AgentTeamFindingSeverity | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return VALID_FINDING_SEVERITIES.has(normalized as AgentTeamFindingSeverity)
    ? (normalized as AgentTeamFindingSeverity)
    : null;
}
