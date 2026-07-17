import { open } from "node:fs/promises";
import type { AgentTeamWorkerOutbox } from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { AgentTeamPaths } from "./storage/agent-team-paths";
import {
  normalizeEvidenceList,
  normalizeFindings,
  normalizeFixVerifications,
  normalizeRecommendations,
  normalizeReviewFindingReproduction,
} from "./outbox-normalizer";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;
type OutboxCandidate = {
  path: string;
  allowMissingPaneIdentity: boolean;
};
export interface AgentTeamResolvedOutbox {
  outbox: AgentTeamWorkerOutbox;
  path: string;
  mtimeMs: number | null;
  rawContent: string;
}
export interface NormalizeAgentTeamWorkerOutboxOptions {
  terminalSessionId?: string;
  projectId?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  completionReason?: string | null;
  finishedAt?: string;
}

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
      const snapshot = await readStableOutboxSnapshot(candidate.path);
      if (!snapshot) {
        continue;
      }
      const { outbox, rawContent, mtimeMs } = snapshot;
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
      return {
        outbox: resolvedOutbox,
        path: candidate.path,
        mtimeMs,
        rawContent,
      };
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

async function readStableOutboxSnapshot(path: string): Promise<{
  outbox: AgentTeamWorkerOutbox;
  rawContent: string;
  mtimeMs: number;
} | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    const rawContent = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return null;
    }
    return {
      outbox: JSON.parse(rawContent) as AgentTeamWorkerOutbox,
      rawContent,
      mtimeMs: after.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
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
    dispatchId:
      typeof record.dispatchId === "string" && record.dispatchId.trim()
        ? record.dispatchId.trim()
        : null,
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
    completionReason:
      record.completionReason ?? options.completionReason ?? null,
    reviewTarget: normalizeReviewTarget(record.reviewTarget),
    verifiedCheckpointCommit:
      typeof record.verifiedCheckpointCommit === "string" &&
      record.verifiedCheckpointCommit.trim()
        ? record.verifiedCheckpointCommit.trim()
        : null,
    finishedAt:
      typeof record.finishedAt === "string"
        ? record.finishedAt
        : (options.finishedAt ?? new Date(0).toISOString()),
    findings: normalizeFindings(record.findings, "open"),
    resolvedFindings: normalizeFindings(record.resolvedFindings, "resolved"),
    remainingFindings:
      Array.isArray(record.remainingFindings) &&
      record.remainingFindings.length === 0
        ? []
        : normalizeFindings(record.remainingFindings, "open"),
    recommendations: normalizeRecommendations(record.recommendations),
    fixVerifications: normalizeFixVerifications(record.fixVerifications),
    acceptanceResults: normalizeAcceptanceResults(
      record.acceptanceResults,
      typeof record.error === "string" ? record.error : null,
    ),
  };
}

function normalizeReviewTarget(
  value: AgentTeamWorkerOutbox["reviewTarget"],
): AgentTeamWorkerOutbox["reviewTarget"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (
    !["full", "incremental", "final"].includes(value.scope) ||
    typeof value.baseCommit !== "string" ||
    !value.baseCommit.trim() ||
    typeof value.targetTree !== "string" ||
    !value.targetTree.trim() ||
    !Array.isArray(value.changedPaths) ||
    !value.changedPaths.every((item) => typeof item === "string") ||
    typeof value.requestedAt !== "string" ||
    !value.requestedAt.trim()
  ) {
    return null;
  }
  return {
    scope: value.scope,
    baseCommit: value.baseCommit.trim(),
    targetTree: value.targetTree.trim(),
    changedPaths: value.changedPaths.map((item) => item.trim()),
    planSha256:
      typeof value.planSha256 === "string" ? value.planSha256.trim() : null,
    testCaseSha256:
      typeof value.testCaseSha256 === "string"
        ? value.testCaseSha256.trim()
        : null,
    requestedAt: value.requestedAt.trim(),
  };
}

function normalizeAcceptanceResults(
  results: AgentTeamWorkerOutbox["acceptanceResults"],
  singleFailureFallback: string | null,
): AgentTeamWorkerOutbox["acceptanceResults"] {
  if (!Array.isArray(results)) {
    return undefined;
  }
  const failureCount = results.filter(
    (result) => result.status === "fail",
  ).length;
  return results
    .filter(
      (result) =>
        typeof result.caseId === "string" &&
        (result.status === "pass" ||
          result.status === "fail" ||
          result.status === "skipped"),
    )
    .map((result) => {
      const reproduction = normalizeReviewFindingReproduction(
        result.reproduction,
      );
      return {
        caseId: result.caseId,
        status: result.status,
        ...(typeof result.summary === "string" && result.summary.trim()
          ? { summary: result.summary.trim() }
          : result.status === "fail" &&
              failureCount === 1 &&
              singleFailureFallback?.trim()
            ? { summary: singleFailureFallback.trim() }
            : {}),
        ...(typeof result.skipReason === "string" && result.skipReason.trim()
          ? { skipReason: result.skipReason.trim() }
          : {}),
        evidence: normalizeEvidenceList(result.evidence),
        ...(reproduction ? { reproduction } : {}),
      };
    });
}
