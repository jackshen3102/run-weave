import { logger } from "../logging/index";
import { EfficiencyScheduledSource } from "../execution-efficiency/scheduled-source";
import { ExecutionEfficiencyService } from "../execution-efficiency/service";
import { ExecutionEfficiencyStore } from "../execution-efficiency/storage";
import type { ScheduledTaskService } from "../scheduled-tasks/service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { resolveExecutionEfficiencyStoragePaths } from "../utils/path";
import type { ResourceScope } from "./resource-scope";

export function createExecutionEfficiency(
  resources: ResourceScope,
  input: {
    browserProfileDir: string;
    terminalSessionManager: TerminalSessionManager;
    scheduledTaskService: ScheduledTaskService;
  },
): ExecutionEfficiencyService {
  const scheduledSource = new EfficiencyScheduledSource(input.scheduledTaskService);
  try {
    const paths = resolveExecutionEfficiencyStoragePaths(input.browserProfileDir);
    const store = new ExecutionEfficiencyStore(paths.databaseFile);
    resources.defer("execution-efficiency-store", () => store.close());
    return new ExecutionEfficiencyService(
      store,
      input.terminalSessionManager,
      scheduledSource,
    );
  } catch (error) {
    logger.error("execution-efficiency.initialize.failed", {
      component: "execution-efficiency",
      message: "Execution efficiency storage failed to initialize",
      error,
    });
    return new ExecutionEfficiencyService(
      null,
      input.terminalSessionManager,
      scheduledSource,
      "Execution efficiency storage failed to initialize",
    );
  }
}
