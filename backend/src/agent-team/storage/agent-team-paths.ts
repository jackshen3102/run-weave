import path from "node:path";
import type { TerminalSessionManager } from "../../terminal/manager";
import { isTerminalChildProjectIdLike } from "@runweave/shared/terminal/project-context";
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

  outboxHistoryDir(
    projectId: string | null,
    runId: string,
    cwd?: string | null,
  ): string {
    assertSafeAgentTeamRunId(runId);
    return path.join(
      this.projectRoot(projectId, cwd),
      ".runweave",
      "outbox-history",
      runId,
    );
  }

  outboxHistoryPath(
    projectId: string | null,
    runId: string,
    round: number,
    identity: {
      role: string;
      panelId?: string | null;
      tmuxPaneId?: string | null;
      dispatchId: string;
      contentSha256: string;
    },
    cwd?: string | null,
  ): string {
    const paneIdentity = identity.panelId
      ? `panel-${sanitizeOutboxSegment(identity.panelId)}`
      : identity.tmuxPaneId
        ? `pane-${sanitizeOutboxSegment(identity.tmuxPaneId)}`
        : "pane-unbound";
    const roundDirectory = `round-${String(
      Math.max(0, Math.trunc(round)),
    ).padStart(4, "0")}`;
    const fileName = [
      sanitizeOutboxSegment(identity.role),
      paneIdentity,
      sanitizeOutboxSegment(identity.dispatchId),
      sanitizeOutboxSegment(identity.contentSha256.slice(0, 12)),
    ].join("-");
    return path.join(
      this.outboxHistoryDir(projectId, runId, cwd),
      roundDirectory,
      `${fileName}.json`,
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
      if (isTerminalChildProjectIdLike(projectId)) {
        throw new Error("Terminal project context is unavailable");
      }
    }
    return cwd || this.cwd;
  }
}

function sanitizeOutboxSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}
