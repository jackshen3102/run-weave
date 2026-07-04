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

  /** Where behavior_verify / worker outboxes are written, keyed by session. */
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
