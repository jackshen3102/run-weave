import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type {
  CreateScheduledTaskRequest,
  ScheduledRun,
  ScheduledRunOutput,
  ScheduledTask,
  ScheduledTaskCapabilities,
  ScheduledTaskFilter,
  ScheduledTaskPage,
  ScheduledTaskValidation,
  SchedulePreviewResponse,
  TaskSchedule,
  UpdateScheduledTaskRequest,
} from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { ScheduledTaskError, scheduledTaskErrorFromStorage } from "./errors";
import type { ScheduledTaskRuntime } from "./runtime";
import type { ScheduledTerminalAttachment } from "./terminal-attachment";
import type { OpenScheduledRunResponse } from "@runweave/shared/scheduled-tasks";
import {
  nextOccurrences,
  ScheduleValidationError,
  validateSchedule,
} from "./schedule";
import type { ScheduledTaskStore } from "./storage/store";
import { createScheduledRunRecord } from "./run-record";

const OUTPUT_PAGE_BYTES = 64 * 1_024;

export class ScheduledTaskService {
  constructor(
    private readonly store: ScheduledTaskStore | null,
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly capabilitiesValue: ScheduledTaskCapabilities,
    private readonly unavailableReason: string | null = null,
  ) {}

  private runtime: ScheduledTaskRuntime | null = null;
  private attachment: ScheduledTerminalAttachment | null = null;

  attachRuntime(runtime: ScheduledTaskRuntime): void {
    this.runtime = runtime;
  }

  attachTerminalAttachment(attachment: ScheduledTerminalAttachment): void {
    this.attachment = attachment;
  }

  capabilities(): ScheduledTaskCapabilities {
    if (this.unavailableReason)
      throw new ScheduledTaskError(
        "scheduler_unavailable",
        503,
        this.unavailableReason,
      );
    return this.capabilitiesValue;
  }

  preview(schedule: TaskSchedule, now = new Date()): SchedulePreviewResponse {
    try {
      const occurrences = nextOccurrences(schedule, now, 3);
      if (schedule.kind === "once" && occurrences.length === 0) {
        throw new ScheduleValidationError(
          "once schedule must be in the future",
        );
      }
      return { now: now.toISOString(), occurrences };
    } catch (error) {
      throw scheduleError(error);
    }
  }

  async create(
    input: CreateScheduledTaskRequest,
    idempotencyKey: string,
  ): Promise<ScheduledTask> {
    const { store, project, nextRunAt, now } = this.prepareCreate(input);
    const task: ScheduledTask = {
      ...normalizeConfig(input),
      id: randomUUID(),
      revision: 1,
      enabled: input.enabled,
      nextRunAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deletedAt: null,
    };
    try {
      return await store.createTask(
        task,
        this.terminalSessionManager.resolveParentProjectId(project.id),
        idempotencyKey,
        hash(input),
      );
    } catch (error) {
      throw scheduledTaskErrorFromStorage(error);
    }
  }

  validateCreate(input: CreateScheduledTaskRequest): ScheduledTaskValidation {
    const { project, nextRunAt, now } = this.prepareCreate(input);
    return validationResult(input, project, nextRunAt, now, null);
  }

  private prepareCreate(input: CreateScheduledTaskRequest) {
    this.requireEnabled();
    this.requireProvider(input.provider);
    this.requireExecutionPolicy(input.provider, input.executionPolicy);
    try {
      validateSchedule(input.schedule);
      if (
        input.schedule.kind === "once" &&
        nextOccurrences(input.schedule, new Date(), 1).length === 0
      ) {
        throw new ScheduleValidationError(
          "once schedule must be in the future",
        );
      }
    } catch (error) {
      throw scheduleError(error);
    }
    const store = this.requireStore();
    const project = this.requireProject(input.projectId);
    const now = new Date();
    const nextRunAt = input.enabled
      ? this.requireNextOccurrence(input.schedule, now)
      : null;
    return { store, project, nextRunAt, now };
  }

  async getTask(taskId: string): Promise<ScheduledTask> {
    const task = await this.requireStore().getTask(taskId);
    if (!task)
      throw new ScheduledTaskError(
        "scheduled_task_not_found",
        404,
        "Scheduled task not found",
      );
    return task;
  }

  async list(
    filter: ScheduledTaskFilter,
  ): Promise<ScheduledTaskPage<ScheduledTask>> {
    const all = await this.requireStore().listTasks();
    const query = filter.q?.trim().toLocaleLowerCase();
    const filtered = all.filter((task) => {
      if (Boolean(task.deletedAt) !== Boolean(filter.archived)) return false;
      if (filter.projectId && task.projectId !== filter.projectId) return false;
      if (
        filter.parentProjectId &&
        this.terminalSessionManager.resolveParentProjectId(task.projectId) !==
          filter.parentProjectId
      )
        return false;
      if (
        query &&
        !`${task.name}\n${task.prompt}`.toLocaleLowerCase().includes(query)
      )
        return false;
      return true;
    });
    return paginate(filtered, filter.cursor, filter.limit);
  }

  async update(
    taskId: string,
    input: UpdateScheduledTaskRequest,
  ): Promise<ScheduledTask> {
    const { task, project } = await this.prepareUpdate(taskId, input);
    try {
      return await this.requireStore().updateTask(
        task,
        input.expectedRevision,
        this.terminalSessionManager.resolveParentProjectId(project.id),
      );
    } catch (error) {
      throw scheduledTaskErrorFromStorage(error);
    }
  }

  async validateUpdate(
    taskId: string,
    input: UpdateScheduledTaskRequest,
  ): Promise<ScheduledTaskValidation> {
    const { task, project, now } = await this.prepareUpdate(taskId, input);
    return validationResult(
      task,
      project,
      task.nextRunAt,
      now,
      input.expectedRevision,
    );
  }

  private async prepareUpdate(
    taskId: string,
    input: UpdateScheduledTaskRequest,
  ) {
    this.requireEnabled();
    const current = await this.getTask(taskId);
    if (current.deletedAt)
      throw new ScheduledTaskError(
        "invalid_input",
        400,
        "Deleted tasks are read-only",
      );
    if (current.revision !== input.expectedRevision)
      throw new ScheduledTaskError(
        "revision_conflict",
        409,
        "The task changed; refresh before saving",
      );
    const now = new Date();
    const projectId = input.projectId ?? current.projectId;
    const project = this.requireProject(projectId);
    const schedule = input.schedule ?? current.schedule;
    this.requireProvider(input.provider ?? current.provider);
    this.requireExecutionPolicy(
      input.provider ?? current.provider,
      input.executionPolicy ?? current.executionPolicy,
    );
    try {
      validateSchedule(schedule);
      if (
        schedule.kind === "once" &&
        nextOccurrences(schedule, now, 1).length === 0
      ) {
        throw new ScheduleValidationError(
          "once schedule must be in the future",
        );
      }
    } catch (error) {
      throw scheduleError(error);
    }
    const enabled = input.enabled ?? current.enabled;
    const nextRunAt = enabled
      ? this.requireNextOccurrence(schedule, now)
      : null;
    const task: ScheduledTask = {
      ...current,
      ...input,
      projectId,
      name: input.name?.trim() ?? current.name,
      prompt: input.prompt?.trim() ?? current.prompt,
      model:
        input.model === undefined
          ? current.model
          : input.model === null
            ? undefined
            : input.model.trim(),
      effort:
        input.effort === undefined
          ? current.effort
          : input.effort === null
            ? undefined
            : input.effort.trim(),
      schedule,
      misfirePolicy: input.misfirePolicy ?? current.misfirePolicy,
      enabled,
      nextRunAt,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    };
    delete (task as ScheduledTask & { expectedRevision?: number })
      .expectedRevision;
    return { task, project, now };
  }

  async remove(
    taskId: string,
    expectedRevision: number,
  ): Promise<ScheduledTask> {
    this.requireEnabled();
    const current = await this.getTask(taskId);
    if (current.deletedAt) return current;
    if (current.revision !== expectedRevision)
      throw new ScheduledTaskError(
        "revision_conflict",
        409,
        "The task changed; refresh before deleting",
      );
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      ...current,
      revision: current.revision + 1,
      enabled: false,
      nextRunAt: null,
      updatedAt: now,
      deletedAt: now,
    };
    try {
      return await this.requireStore().updateTask(
        task,
        expectedRevision,
        this.terminalSessionManager.resolveParentProjectId(task.projectId),
      );
    } catch (error) {
      throw scheduledTaskErrorFromStorage(error);
    }
  }

  async start(taskId: string, idempotencyKey: string): Promise<ScheduledRun> {
    this.requireEnabled();
    const task = await this.getTask(taskId);
    if (task.deletedAt)
      throw new ScheduledTaskError(
        "invalid_input",
        400,
        "Deleted tasks cannot run",
      );
    this.requireProvider(task.provider);
    this.requireExecutionPolicy(task.provider, task.executionPolicy);
    const project = this.requireProject(task.projectId);
    const now = new Date().toISOString();
    const run = createScheduledRunRecord(task, "manual", now, project.path!);
    try {
      const created = await this.requireStore().createManualRun(
        run,
        idempotencyKey,
        hash({ taskId }),
      );
      this.runtime?.wake();
      return created;
    } catch (error) {
      throw scheduledTaskErrorFromStorage(error);
    }
  }

  async listRuns(
    taskId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ScheduledTaskPage<ScheduledRun>> {
    await this.getTask(taskId);
    return paginate(await this.requireStore().listRuns(taskId), cursor, limit);
  }

  async getRun(runId: string): Promise<ScheduledRun> {
    const run = await this.requireStore().getRun(runId);
    if (!run)
      throw new ScheduledTaskError(
        "scheduled_run_not_found",
        404,
        "Scheduled run not found",
      );
    return run;
  }

  async output(runId: string, cursor?: string): Promise<ScheduledRunOutput> {
    const offset = decodeOffset(cursor);
    try {
      const chunk = await this.requireStore().readOutput(
        runId,
        offset,
        OUTPUT_PAGE_BYTES,
      );
      return {
        text: chunk.text,
        nextCursor: String(chunk.nextOffset),
        hasMore: chunk.nextOffset < chunk.totalBytes,
      };
    } catch (error) {
      throw scheduledTaskErrorFromStorage(error);
    }
  }

  async stop(runId: string): Promise<ScheduledRun> {
    const run = await this.getRun(runId);
    if (!["queued", "running", "stopping"].includes(run.status)) return run;
    return this.runtime?.stop(runId) ?? run;
  }

  async openTerminal(
    runId: string,
    replaceRepurposedBinding = false,
  ): Promise<OpenScheduledRunResponse> {
    if (!this.attachment)
      throw new ScheduledTaskError(
        "scheduler_unavailable",
        503,
        "Terminal attachment is unavailable",
      );
    return this.attachment.open(
      await this.getRun(runId),
      replaceRepurposedBinding,
    );
  }

  private requireStore(): ScheduledTaskStore {
    if (!this.store)
      throw new ScheduledTaskError(
        "scheduler_unavailable",
        503,
        this.unavailableReason ?? "Scheduled task storage is unavailable",
      );
    return this.store;
  }

  private requireEnabled(): void {
    this.capabilities();
    if (!this.capabilitiesValue.enabled)
      throw new ScheduledTaskError(
        "scheduler_unavailable",
        503,
        this.capabilitiesValue.reason ?? "Scheduled tasks are disabled",
      );
  }

  private requireProvider(provider: string): void {
    const capability = this.capabilitiesValue.providers.find(
      (item) => item.provider === provider,
    );
    if (!capability?.available)
      throw new ScheduledTaskError(
        "provider_unavailable",
        503,
        capability?.reason ?? "Provider unavailable",
      );
  }

  private requireExecutionPolicy(
    provider: string,
    policy?: ScheduledTask["executionPolicy"],
  ): void {
    if (!policy || policy === "sandbox") return;
    const capability = this.capabilitiesValue.providers.find(
      (item) => item.provider === provider,
    );
    if (!capability?.executionPolicies?.includes(policy))
      throw new ScheduledTaskError(
        "execution_policy_unavailable",
        409,
        "当前 Agent 不支持所选执行权限，请更新 Codex 或选择其他权限。",
      );
  }

  private requireProject(projectId: string) {
    const project = this.terminalSessionManager.getProject(projectId);
    if (!project?.path || !isDirectory(project.path))
      throw new ScheduledTaskError(
        "context_unavailable",
        409,
        "The selected project directory is unavailable",
      );
    return project;
  }

  private requireNextOccurrence(schedule: TaskSchedule, now: Date): string {
    try {
      const next = nextOccurrences(schedule, now, 1)[0];
      if (!next)
        throw new ScheduleValidationError("schedule has no future occurrence");
      return next;
    } catch (error) {
      throw scheduleError(error);
    }
  }
}

function validationResult(
  input: CreateScheduledTaskRequest | ScheduledTask,
  project: { id: string; name: string; path: string | null },
  nextRunAt: string | null,
  now: Date,
  currentRevision: number | null,
): ScheduledTaskValidation {
  return {
    config: { ...normalizeConfig(input), enabled: input.enabled },
    project: { id: project.id, name: project.name, path: project.path! },
    provider: input.provider,
    enabled: input.enabled,
    nextRunAt,
    occurrences: nextOccurrences(input.schedule, now, 3),
    currentRevision,
  };
}

function normalizeConfig(input: CreateScheduledTaskRequest | ScheduledTask) {
  return {
    name: input.name.trim(),
    projectId: input.projectId,
    provider: input.provider,
    prompt: input.prompt.trim(),
    ...(input.executionPolicy
      ? { executionPolicy: input.executionPolicy }
      : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort?.trim() ? { effort: input.effort.trim() } : {}),
    schedule: input.schedule,
    misfirePolicy: input.misfirePolicy,
  };
}
function paginate<T>(
  items: T[],
  cursor?: string,
  requestedLimit?: number,
): ScheduledTaskPage<T> {
  const offset = decodeOffset(cursor);
  const limit = Math.min(100, Math.max(1, requestedLimit ?? 50));
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    nextCursor:
      offset + page.length < items.length ? String(offset + page.length) : null,
  };
}
function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ScheduledTaskError("invalid_input", 400, "Invalid cursor");
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function isDirectory(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}
function scheduleError(error: unknown): ScheduledTaskError {
  return new ScheduledTaskError(
    "invalid_schedule",
    400,
    error instanceof Error ? error.message : "Invalid schedule",
  );
}
