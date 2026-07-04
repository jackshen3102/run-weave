import type {
  AgentTeamWorkerOutbox,
  TerminalEventEnvelope,
} from "@runweave/shared";
import type { AgentTeamPaths } from "./storage/agent-team-paths";
import { readJsonFile } from "./storage/json-file";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;

/**
 * Resolve the worker outbox (with per-case acceptanceResults) for a pane
 * completion event. Reads the outbox JSON keyed by session id.
 */
export class AgentTeamOutboxResolver {
  constructor(private readonly paths: AgentTeamPaths) {}

  async resolveOutbox(
    event: CompletionEvent,
  ): Promise<AgentTeamWorkerOutbox | null> {
    const outboxPath =
      event.payload.outboxPath ??
      this.paths.defaultOutboxPath(
        event.projectId,
        event.terminalSessionId,
        event.payload.cwd,
      );
    const outbox = await readJsonFile<AgentTeamWorkerOutbox>(outboxPath);
    if (!outbox) {
      return null;
    }
    return {
      ...outbox,
      sessionId: outbox.sessionId || event.terminalSessionId,
      projectId: outbox.projectId ?? event.projectId,
      panelId: outbox.panelId ?? event.payload.panelId ?? null,
      tmuxPaneId: outbox.tmuxPaneId ?? event.payload.tmuxPaneId ?? null,
      completionReason: outbox.completionReason ?? event.payload.completionReason,
      finishedAt: outbox.finishedAt ?? event.createdAt,
    };
  }
}
