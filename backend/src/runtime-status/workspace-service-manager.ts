import type { RuntimeStatusItem } from "@runweave/shared/runtime-status";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { WorkspaceServiceManager } from "../terminal/workspace-service/manager";
import { buildWorkspaceServiceRuntimeStatusItems } from "../terminal/workspace-service/runtime-status";

export class RuntimeStatusWorkspaceServiceManager extends WorkspaceServiceManager {
  constructor(terminalSessionManager: TerminalSessionManager) {
    super(terminalSessionManager);
  }

  async getRuntimeStatusItems(now = Date.now()): Promise<RuntimeStatusItem[]> {
    for (const parent of this.terminalSessionManager.listProjects()) {
      for (const context of this.terminalSessionManager.listProjectContexts(
        parent.id,
      )) {
        if (context.availability !== "available" || !context.path) continue;
        await this.list(parent.id, context.projectId);
      }
    }
    return buildWorkspaceServiceRuntimeStatusItems(
      this.records.values(),
      this.proxyPort,
      now,
    );
  }
}
