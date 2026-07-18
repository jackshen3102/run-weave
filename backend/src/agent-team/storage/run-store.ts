import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentTeamRun } from "@runweave/shared/agent-team";
import type { TerminalSessionManager } from "../../terminal/manager";
import { assertSafeAgentTeamRunId, isSafeAgentTeamRunId } from "../run-id";
import type { AgentTeamPaths } from "./agent-team-paths";
import { readJsonFile, writeJsonFile } from "./json-file";

export class AgentTeamRunStore {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly paths: AgentTeamPaths,
    private readonly onWrite?: (
      previous: AgentTeamRun | null,
      current: AgentTeamRun,
    ) => void,
  ) {}

  async listRuns(projectId: string): Promise<AgentTeamRun[]> {
    const dir = this.paths.runsDir(projectId);
    if (!existsSync(dir)) {
      return [];
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readJsonFile<AgentTeamRun>(path.join(dir, entry.name)),
        ),
    );
    return runs
      .filter(
        (run): run is AgentTeamRun =>
          Boolean(run?.runId) && run?.projectId === projectId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRun(runId: string): Promise<AgentTeamRun | null> {
    if (!isSafeAgentTeamRunId(runId)) {
      return null;
    }
    for (const project of this.terminalSessionManager.listProjects()) {
      const candidate = this.paths.runFilePath(project.id, runId);
      if (!existsSync(candidate)) {
        continue;
      }
      const run = await readJsonFile<AgentTeamRun>(candidate);
      if (run?.projectId === project.id) {
        return run;
      }
    }
    return null;
  }

  /** Find the active run bound to a terminal session, if any. */
  async getRunByTerminalSession(
    projectId: string,
    terminalSessionId: string,
  ): Promise<AgentTeamRun | null> {
    const runs = await this.listRuns(projectId);
    const terminalRuns = runs.filter(
      (run) => run.terminalSessionId === terminalSessionId,
    );
    return (
      terminalRuns.find(
        (run) => run.status !== "done" && run.status !== "failed",
      ) ?? terminalRuns[0] ?? null
    );
  }

  async writeRun(run: AgentTeamRun): Promise<void> {
    assertSafeAgentTeamRunId(run.runId);
    const filePath = this.paths.runFilePath(run.projectId, run.runId);
    const previous = existsSync(filePath)
      ? await readJsonFile<AgentTeamRun>(filePath)
      : null;
    await writeJsonFile(filePath, run);
    this.onWrite?.(previous, run);
  }

  async deleteRun(run: Pick<AgentTeamRun, "projectId" | "runId">): Promise<void> {
    assertSafeAgentTeamRunId(run.runId);
    await rm(this.paths.runFilePath(run.projectId, run.runId), { force: true });
  }
}
