import type {
  EfficiencyTaskBinding,
} from "@runweave/shared/execution-efficiency";
import type { ScheduledRun, ScheduledTask } from "@runweave/shared/scheduled-tasks";
import type { ScheduledTaskService } from "../scheduled-tasks/service";
import { ExecutionEfficiencyError } from "./errors";

export class EfficiencyScheduledSource {
  constructor(private readonly scheduledTasks: ScheduledTaskService) {}

  async validateBinding(projectId: string, taskId: string): Promise<ScheduledTask> {
    const task = await this.scheduledTasks.getTask(taskId).catch(() => null);
    if (!task || task.deletedAt || task.projectId !== projectId) {
      throw new ExecutionEfficiencyError(
        "task_not_found",
        404,
        "Scheduled task does not belong to this project",
      );
    }
    if (task.provider !== "codex") {
      throw new ExecutionEfficiencyError(
        "unsupported_provider",
        400,
        "The first execution-efficiency version requires a Codex task",
      );
    }
    return task;
  }

  async requireActiveRun(
    binding: EfficiencyTaskBinding,
    scheduledRunId: string,
  ): Promise<ScheduledRun> {
    const run = await this.scheduledTasks.getRun(scheduledRunId).catch(() => null);
    if (
      !run ||
      run.taskId !== binding.taskId ||
      run.executionProjectId !== binding.projectId
    ) {
      throw new ExecutionEfficiencyError(
        "run_not_found",
        404,
        "Scheduled run does not belong to the bound task and project",
      );
    }
    if (!new Set(["running", "stopping"]).has(run.status)) {
      throw new ExecutionEfficiencyError(
        "run_owner_conflict",
        409,
        "Scheduled run is no longer the active analysis owner",
      );
    }
    return run;
  }

  getRun(runId: string): Promise<ScheduledRun> {
    return this.scheduledTasks.getRun(runId);
  }
}
