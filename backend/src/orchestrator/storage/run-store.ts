import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { OrchestratorRunPackage } from "@runweave/shared";
import type { TerminalSessionManager } from "../../terminal/manager";
import {
  assertSafeOrchestratorRunId,
  isSafeOrchestratorRunId,
} from "../run-id";
import type { OrchestratorPaths } from "./orchestrator-paths";
import { readJsonFile, writeJsonFile } from "./json-file";

export class OrchestratorRunStore {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly paths: OrchestratorPaths,
  ) {}

  async listRuns(projectId: string): Promise<OrchestratorRunPackage[]> {
    const dir = this.paths.runsDir(projectId);
    if (!existsSync(dir)) {
      return [];
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readJsonFile<OrchestratorRunPackage>(path.join(dir, entry.name)),
        ),
    );
    return runs
      .filter((run): run is OrchestratorRunPackage => Boolean(run?.runId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRun(runId: string): Promise<OrchestratorRunPackage | null> {
    if (!isSafeOrchestratorRunId(runId)) {
      return null;
    }
    for (const project of this.terminalSessionManager.listProjects()) {
      const candidate = this.paths.runFilePath(project.id, runId);
      if (!existsSync(candidate)) {
        continue;
      }
      return readJsonFile<OrchestratorRunPackage>(candidate);
    }
    return null;
  }

  async writeRun(run: OrchestratorRunPackage): Promise<void> {
    assertSafeOrchestratorRunId(run.runId);
    await writeJsonFile(this.paths.runFilePath(run.projectId, run.runId), run);
  }
}
