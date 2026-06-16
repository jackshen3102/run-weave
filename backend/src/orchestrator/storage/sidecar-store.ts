import type { OrchestratorDispatchSidecar } from "@runweave/shared";
import type { OrchestratorPaths } from "./orchestrator-paths";
import { readJsonFile, writeJsonFile } from "./json-file";

export class OrchestratorSidecarStore {
  constructor(private readonly paths: OrchestratorPaths) {}

  async readDispatchSidecar(params: {
    projectId: string | null;
    terminalSessionId: string;
    cwd?: string | null;
  }): Promise<OrchestratorDispatchSidecar | null> {
    return readJsonFile<OrchestratorDispatchSidecar>(
      this.paths.dispatchSidecarPath(
        params.projectId,
        params.terminalSessionId,
        params.cwd,
      ),
    );
  }

  async writeDispatchSidecar(
    projectId: string | null,
    sidecar: OrchestratorDispatchSidecar,
  ): Promise<void> {
    await writeJsonFile(
      this.paths.dispatchSidecarPath(projectId, sidecar.sessionId),
      sidecar,
    );
  }
}
