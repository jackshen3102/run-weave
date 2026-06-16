import path from "node:path";
import type { TerminalSessionManager } from "../../terminal/manager";
import { assertSafeOrchestratorRunId } from "../run-id";

export class OrchestratorPaths {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly homeDir: string,
    private readonly cwd: string,
  ) {}

  rolesFilePath(): string {
    return path.join(this.homeDir, ".runweave", "roles.json");
  }

  runsDir(projectId: string): string {
    return path.join(this.projectRoot(projectId), ".runweave", "runs");
  }

  runFilePath(projectId: string, runId: string): string {
    assertSafeOrchestratorRunId(runId);
    return path.join(this.runsDir(projectId), `${runId}.json`);
  }

  dispatchSidecarPath(
    projectId: string | null,
    sessionId: string,
    cwd?: string | null,
  ): string {
    return path.join(
      this.projectRoot(projectId, cwd),
      ".runweave",
      "dispatch",
      `${sessionId}.json`,
    );
  }

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
