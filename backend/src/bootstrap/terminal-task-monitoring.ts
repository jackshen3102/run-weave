import path from "node:path";
import type { ActivityStore } from "../activity/recording/store";
import { TaskHandoffService } from "../task-handoff/service";
import { TaskSupervisionService } from "../task-supervision/service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import type { ResourceScope } from "./resource-scope";

export async function createTerminalTaskMonitoring(
  directory: string,
  manager: TerminalSessionManager,
  activity: ActivityStore | null,
  resources: ResourceScope,
) {
  const appServerHistoryGateway = new AppServerHistoryGateway();
  const taskHandoffService = new TaskHandoffService(
    path.join(directory, "task-handoff"), manager, appServerHistoryGateway, activity,
  );
  resources.defer("task-handoff", () => taskHandoffService.dispose());
  const taskSupervisionService = new TaskSupervisionService(
    path.join(directory, "task-supervision"), manager, appServerHistoryGateway,
  );
  resources.defer("task-supervision", () => taskSupervisionService.dispose());
  await taskSupervisionService.initialize();
  return { appServerHistoryGateway, taskHandoffService, taskSupervisionService };
}
