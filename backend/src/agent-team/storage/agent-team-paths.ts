import path from "node:path";
import type { TerminalSessionManager } from "../../terminal/manager";
import { assertSafeAgentTeamRunId } from "../run-id";

export class AgentTeamPaths {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly cwd: string,
  ) {}

  runsDir(projectId: string): string {
    return path.join(this.projectRoot(projectId), ".runweave", "agent-team");
  }

  runFilePath(projectId: string, runId: string): string {
    assertSafeAgentTeamRunId(runId);
    return path.join(this.runsDir(projectId), `${runId}.json`);
  }

  /** Legacy worker outbox path, keyed only by terminal session. */
  defaultOutboxPath(
    projectId: string | null,
    sessionId: string,
    cwd?: string | null,
  ): string {
    return path.join(
      this.projectRoot(projectId, cwd),
      ".runweave",
      "outbox",
      `${sessionId}.json`,
    );
  }

  /** Worker outbox path scoped to the pane that owns the completion event. */
  workerOutboxPath(
    projectId: string | null,
    sessionId: string,
    pane: { panelId?: string | null; tmuxPaneId?: string | null },
    cwd?: string | null,
  ): string {
    return path.join(
      this.projectRoot(projectId, cwd),
      this.workerOutboxRelativePath(sessionId, pane),
    );
  }

  workerOutboxRelativePath(
    sessionId: string,
    pane: { panelId?: string | null; tmuxPaneId?: string | null },
  ): string {
    return path.join(
      ".runweave",
      "outbox",
      this.workerOutboxFileName(sessionId, pane),
    );
  }

  private workerOutboxFileName(
    sessionId: string,
    pane: { panelId?: string | null; tmuxPaneId?: string | null },
  ): string {
    if (pane.panelId) {
      return `${sanitizeOutboxSegment(sessionId)}.panel-${sanitizeOutboxSegment(
        pane.panelId,
      )}.json`;
    }
    if (pane.tmuxPaneId) {
      return `${sanitizeOutboxSegment(sessionId)}.pane-${sanitizeOutboxSegment(
        pane.tmuxPaneId,
      )}.json`;
    }
    return `${sanitizeOutboxSegment(sessionId)}.json`;
  }

  private projectRoot(projectId: string | null, cwd?: string | null): string {
    if (projectId) {
      const project = this.terminalSessionManager.getProject(projectId);
      if (project?.path) {
        return project.path;
      }
    }
    return cwd || this.cwd;
  }
}

function sanitizeOutboxSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}
