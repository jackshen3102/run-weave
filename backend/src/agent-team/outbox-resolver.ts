import type {
  AgentTeamAcceptanceEvidence,
  AgentTeamWorkerOutbox,
  TerminalEventEnvelope,
} from "@runweave/shared";
import type { AgentTeamPaths } from "./storage/agent-team-paths";
import { readJsonFile } from "./storage/json-file";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;
type OutboxCandidate = {
  path: string;
  allowMissingPaneIdentity: boolean;
};

const VALID_EVIDENCE_TYPES = new Set<AgentTeamAcceptanceEvidence["type"]>([
  "screenshot",
  "dom",
  "text",
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
      const normalized = this.normalizeOutbox(event, outbox);
      return {
        ...normalized,
        sessionId: normalized.sessionId || event.terminalSessionId,
        projectId: normalized.projectId ?? event.projectId,
        panelId: normalized.panelId ?? event.payload.panelId ?? null,
        tmuxPaneId: normalized.tmuxPaneId ?? event.payload.tmuxPaneId ?? null,
        completionReason:
          normalized.completionReason ?? event.payload.completionReason,
        finishedAt: normalized.finishedAt ?? event.createdAt,
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

  private normalizeOutbox(
    event: CompletionEvent,
    outbox: AgentTeamWorkerOutbox,
  ): AgentTeamWorkerOutbox {
    const legacyOutbox = outbox as AgentTeamWorkerOutbox & {
      conclusion?: unknown;
      terminalSessionId?: unknown;
      workerRole?: unknown;
    };
    const normalizedStatus =
      outbox.status === "failed" ? "failed" : "completed";
    return {
      ...outbox,
      sessionId:
        outbox.sessionId ||
        (typeof legacyOutbox.terminalSessionId === "string"
          ? legacyOutbox.terminalSessionId
          : event.terminalSessionId),
      role:
        outbox.role ??
        (typeof legacyOutbox.workerRole === "string"
          ? legacyOutbox.workerRole
          : null),
      status: normalizedStatus,
      summary:
        typeof outbox.summary === "string"
          ? outbox.summary
          : typeof legacyOutbox.conclusion === "string"
            ? legacyOutbox.conclusion
            : "Worker completed",
      error: typeof outbox.error === "string" ? outbox.error : null,
      finishedAt:
        typeof outbox.finishedAt === "string"
          ? outbox.finishedAt
          : event.createdAt,
      acceptanceResults: this.normalizeAcceptanceResults(
        outbox.acceptanceResults,
      ),
    };
  }

  private normalizeAcceptanceResults(
    results: AgentTeamWorkerOutbox["acceptanceResults"],
  ): AgentTeamWorkerOutbox["acceptanceResults"] {
    if (!Array.isArray(results)) {
      return undefined;
    }
    return results
      .filter(
        (result) =>
          typeof result.caseId === "string" &&
          (result.status === "pass" || result.status === "fail"),
      )
      .map((result) => ({
        caseId: result.caseId,
        status: result.status,
        evidence: Array.isArray(result.evidence)
          ? result.evidence
              .filter((evidence) => typeof evidence.ref === "string")
              .map((evidence) => ({
                type: VALID_EVIDENCE_TYPES.has(evidence.type)
                  ? evidence.type
                  : "text",
                ref: evidence.ref,
              }))
          : [],
      }));
  }
}
