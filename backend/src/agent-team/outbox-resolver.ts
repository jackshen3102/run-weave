import { stat } from "node:fs/promises";
import type { AgentTeamAcceptanceEvidence, AgentTeamFindingSeverity, AgentTeamFindingStatus, AgentTeamOutboxFinding, AgentTeamOutboxRecommendation, AgentTeamWorkerOutbox } from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { AgentTeamPaths } from "./storage/agent-team-paths";
import { readJsonFile } from "./storage/json-file";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;
type OutboxCandidate = {
  path: string;
  allowMissingPaneIdentity: boolean;
};
export interface AgentTeamResolvedOutbox {
  outbox: AgentTeamWorkerOutbox;
  path: string;
  mtimeMs: number | null;
}
export interface NormalizeAgentTeamWorkerOutboxOptions {
  terminalSessionId?: string;
  projectId?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  completionReason?: string | null;
  finishedAt?: string;
}

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

/**
 * Resolve the worker outbox (with per-case acceptanceResults) for a pane
 * completion event. Pane-scoped files avoid two workers in the same terminal
 * session overwriting or stealing each other's results.
 */
export class AgentTeamOutboxResolver {
  constructor(private readonly paths: AgentTeamPaths) {}

  async resolveOutbox(
    event: CompletionEvent,
  ): Promise<AgentTeamWorkerOutbox | null> {
    return (await this.resolveOutboxWithMetadata(event))?.outbox ?? null;
  }

  async resolveOutboxWithMetadata(
    event: CompletionEvent,
  ): Promise<AgentTeamResolvedOutbox | null> {
    for (const candidate of this.outboxCandidates(event)) {
      const outbox = await readJsonFile<AgentTeamWorkerOutbox>(candidate.path);
      if (!outbox) {
        continue;
      }
      if (
        !this.matchesCompletionPane(event, outbox, {
          allowMissingPaneIdentity: candidate.allowMissingPaneIdentity,
        })
      ) {
        continue;
      }
      const normalized = normalizeAgentTeamWorkerOutbox(outbox, {
        terminalSessionId: event.terminalSessionId,
        projectId: event.projectId,
        panelId: event.payload.panelId ?? null,
        tmuxPaneId: event.payload.tmuxPaneId ?? null,
        completionReason: event.payload.completionReason,
        finishedAt: event.createdAt,
      });
      if (!normalized) {
        continue;
      }
      const resolvedOutbox = {
        ...normalized,
        sessionId: normalized.sessionId || event.terminalSessionId,
        projectId: normalized.projectId ?? event.projectId,
        panelId: normalized.panelId ?? event.payload.panelId ?? null,
        tmuxPaneId: normalized.tmuxPaneId ?? event.payload.tmuxPaneId ?? null,
        completionReason:
          normalized.completionReason ?? event.payload.completionReason,
        finishedAt: normalized.finishedAt ?? event.createdAt,
      };
      let mtimeMs: number | null = null;
      try {
        mtimeMs = (await stat(candidate.path)).mtimeMs;
      } catch {
        // The next signal can retry if the file changed during resolution.
      }
      return { outbox: resolvedOutbox, path: candidate.path, mtimeMs };
    }
    return null;
  }

  private outboxCandidates(event: CompletionEvent): OutboxCandidate[] {
    const candidates: OutboxCandidate[] = [];
    const addCandidate = (
      path: string,
      options: { allowMissingPaneIdentity: boolean },
    ) => {
      if (candidates.some((candidate) => candidate.path === path)) {
        return;
      }
      candidates.push({
        path,
        allowMissingPaneIdentity: options.allowMissingPaneIdentity,
      });
    };

    if (event.payload.outboxPath) {
      addCandidate(event.payload.outboxPath, {
        allowMissingPaneIdentity: true,
      });
    }
    if (event.payload.panelId) {
      addCandidate(
        this.paths.workerOutboxPath(
          event.projectId,
          event.terminalSessionId,
          { panelId: event.payload.panelId },
          event.payload.cwd,
        ),
        { allowMissingPaneIdentity: true },
      );
    }
    if (event.payload.tmuxPaneId) {
      addCandidate(
        this.paths.workerOutboxPath(
          event.projectId,
          event.terminalSessionId,
          { tmuxPaneId: event.payload.tmuxPaneId },
          event.payload.cwd,
        ),
        { allowMissingPaneIdentity: true },
      );
    }
    addCandidate(
      this.paths.defaultOutboxPath(
        event.projectId,
        event.terminalSessionId,
        event.payload.cwd,
      ),
      { allowMissingPaneIdentity: false },
    );
    return candidates;
  }

  private matchesCompletionPane(
    event: CompletionEvent,
    outbox: AgentTeamWorkerOutbox,
    options: { allowMissingPaneIdentity: boolean },
  ): boolean {
    if (
      event.payload.panelId &&
      outbox.panelId &&
      outbox.panelId !== event.payload.panelId
    ) {
      return false;
    }
    if (
      event.payload.tmuxPaneId &&
      outbox.tmuxPaneId &&
      outbox.tmuxPaneId !== event.payload.tmuxPaneId
    ) {
      return false;
    }
    if (!event.payload.panelId && !event.payload.tmuxPaneId) {
      return true;
    }
    if (
      options.allowMissingPaneIdentity &&
      !outbox.panelId &&
      !outbox.tmuxPaneId
    ) {
      return true;
    }
    if (
      (event.payload.panelId && outbox.panelId === event.payload.panelId) ||
      (event.payload.tmuxPaneId &&
        outbox.tmuxPaneId === event.payload.tmuxPaneId)
    ) {
      return true;
    }
    return false;
  }

}

export function normalizeAgentTeamWorkerOutbox(
  outbox: unknown,
  options: NormalizeAgentTeamWorkerOutboxOptions = {},
): AgentTeamWorkerOutbox | null {
  if (!outbox || typeof outbox !== "object") {
    return null;
  }
  const record = outbox as AgentTeamWorkerOutbox & {
    conclusion?: unknown;
    terminalSessionId?: unknown;
    workerRole?: unknown;
  };
  const normalizedStatus = record.status === "failed" ? "failed" : "completed";
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId
      : typeof record.terminalSessionId === "string" &&
          record.terminalSessionId.trim()
        ? record.terminalSessionId.trim()
        : options.terminalSessionId;
  if (!sessionId) {
    return null;
  }

  return {
    ...record,
    sessionId,
    projectId: record.projectId ?? options.projectId ?? null,
    panelId: record.panelId ?? options.panelId ?? null,
    tmuxPaneId: record.tmuxPaneId ?? options.tmuxPaneId ?? null,
    role:
      record.role ??
      (typeof record.workerRole === "string" ? record.workerRole : null),
    status: normalizedStatus,
    summary:
      typeof record.summary === "string"
        ? record.summary
        : typeof record.conclusion === "string"
          ? record.conclusion
          : "Worker completed",
    error: typeof record.error === "string" ? record.error : null,
    completionReason: record.completionReason ?? options.completionReason ?? null,
    finishedAt:
      typeof record.finishedAt === "string"
        ? record.finishedAt
        : options.finishedAt ?? new Date(0).toISOString(),
    findings: normalizeFindings(record.findings, "open"),
    resolvedFindings: normalizeFindings(record.resolvedFindings, "resolved"),
    remainingFindings: normalizeFindings(record.remainingFindings, "open"),
    recommendations: normalizeRecommendations(record.recommendations),
    acceptanceResults: normalizeAcceptanceResults(record.acceptanceResults),
  };
}

function normalizeAcceptanceResults(
  results: AgentTeamWorkerOutbox["acceptanceResults"],
): AgentTeamWorkerOutbox["acceptanceResults"] {
  if (!Array.isArray(results)) {
    return undefined;
  }
  return results
    .filter(
      (result) =>
        typeof result.caseId === "string" &&
        (result.status === "pass" ||
          result.status === "fail" ||
          result.status === "skipped"),
    )
    .map((result) => ({
      caseId: result.caseId,
      status: result.status,
      ...(typeof result.skipReason === "string" && result.skipReason.trim()
        ? { skipReason: result.skipReason.trim() }
        : {}),
      evidence: Array.isArray(result.evidence)
        ? result.evidence
            .filter(
              (evidence) =>
                VALID_EVIDENCE_TYPES.has(evidence.type) &&
                typeof evidence.ref === "string" &&
                typeof evidence.label === "string" &&
                evidence.label.trim() &&
                typeof evidence.summary === "string" &&
                evidence.summary.trim(),
            )
            .map((evidence) => ({
              type: evidence.type,
              label: evidence.label.trim(),
              summary: evidence.summary.trim(),
              ...(typeof evidence.detail === "string" && evidence.detail.trim()
                ? { detail: evidence.detail.trim() }
                : {}),
              ref: evidence.ref,
            }))
        : [],
    }));
}

function normalizeFindings(
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

function normalizeRecommendations(
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
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
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
  };
}

function normalizeRecommendation(
  recommendation: unknown,
): AgentTeamOutboxRecommendation | null {
  if (!recommendation || typeof recommendation !== "object") {
    return null;
  }
  const record = recommendation as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
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
