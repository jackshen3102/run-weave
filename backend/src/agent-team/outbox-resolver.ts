import type {
  AgentTeamWorkerOutbox,
  TerminalEventEnvelope,
} from "@runweave/shared";
import type { AgentTeamPaths } from "./storage/agent-team-paths";
import { readJsonFile } from "./storage/json-file";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;

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
    for (const candidatePath of this.outboxCandidates(event)) {
      const outbox = await readJsonFile<AgentTeamWorkerOutbox>(candidatePath);
      if (!outbox) {
        continue;
      }
      if (!this.matchesCompletionPane(event, outbox)) {
        continue;
      }
      return {
        ...outbox,
        sessionId: outbox.sessionId || event.terminalSessionId,
        projectId: outbox.projectId ?? event.projectId,
        panelId: outbox.panelId ?? event.payload.panelId ?? null,
        tmuxPaneId: outbox.tmuxPaneId ?? event.payload.tmuxPaneId ?? null,
        completionReason:
          outbox.completionReason ?? event.payload.completionReason,
        finishedAt: outbox.finishedAt ?? event.createdAt,
      };
    }
    return null;
  }

  private outboxCandidates(event: CompletionEvent): string[] {
    const candidates: string[] = [];
    const addCandidate = (path: string) => {
      if (candidates.includes(path)) {
        return;
      }
      candidates.push(path);
    };

    if (event.payload.outboxPath) {
      addCandidate(event.payload.outboxPath);
    }
    if (event.payload.panelId) {
      addCandidate(
        this.paths.workerOutboxPath(
          event.projectId,
          event.terminalSessionId,
          { panelId: event.payload.panelId },
          event.payload.cwd,
        ),
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
      );
    }
    addCandidate(
      this.paths.defaultOutboxPath(
        event.projectId,
        event.terminalSessionId,
        event.payload.cwd,
      ),
    );
    return candidates;
  }

  private matchesCompletionPane(
    event: CompletionEvent,
    outbox: AgentTeamWorkerOutbox,
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
      (event.payload.panelId && outbox.panelId === event.payload.panelId) ||
      (event.payload.tmuxPaneId &&
        outbox.tmuxPaneId === event.payload.tmuxPaneId)
    ) {
      return true;
    }
    return false;
  }
}
