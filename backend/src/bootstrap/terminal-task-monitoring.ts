import { TerminalTaskService } from "../terminal/tasks/service";
import { TerminalTaskStore } from "../terminal/tasks/store";
import type { TerminalSessionCreationOptions } from "../terminal/application/create-session";
import { sendInputToSession } from "../terminal/application/input-dispatcher";
import { buildPaneTarget } from "../terminal/application/panel-common";
import {
  beginSupervisorDelivery,
  terminalInputAdmission,
} from "../terminal/runtime/input-admission";
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
    path.join(directory, "task-handoff"),
    manager,
    appServerHistoryGateway,
    activity,
  );
  resources.defer("task-handoff", () => taskHandoffService.dispose());
  const taskSupervisionService = new TaskSupervisionService(
    path.join(directory, "task-supervision"),
    manager,
    appServerHistoryGateway,
  );
  resources.defer("task-supervision", () => taskSupervisionService.dispose());
  await taskSupervisionService.initialize();
  return {
    appServerHistoryGateway,
    taskHandoffService,
    taskSupervisionService,
  };
}

export async function createTerminalTaskServices(
  directory: string,
  manager: TerminalSessionManager,
  options: TerminalSessionCreationOptions,
  history: AppServerHistoryGateway,
  resources: ResourceScope,
  supervision: TaskSupervisionService,
) {
  const tasks = new TerminalTaskService(
    new TerminalTaskStore(path.join(directory, "terminal-tasks", "state.json")),
    manager,
    options,
    history,
  );
  resources.defer("terminal-tasks", () => tasks.dispose());
  await tasks.initialize();
  supervision.attach(
    options.terminalEventService!,
    async (target, offer, valid) => {
      valid();
      const session = manager.getSession(target.terminalSessionId);
      const panel = manager.getPanel(target.panelId);
      if (!session || !panel || !options.tmuxService)
        throw new Error("原终端输入服务不可用，未发送续接。");
      const release = beginSupervisorDelivery(session);
      const inputRevision = terminalInputAdmission(session).revision;
      try {
        await sendInputToSession(
          manager,
          {
            ...options,
            supervisorInput: true,
            validateSupervisorTarget: () => {
              valid();
              if (terminalInputAdmission(session).revision !== inputRevision)
                throw new Error("用户输入已变化，未发送旧续接。");
            },
          },
          session,
          offer.reason,
          "prompt_paste",
          offer.decisionId,
          buildPaneTarget(session, options.tmuxService, panel),
        );
      } finally {
        await release();
      }
    },
  );
  return tasks;
}
