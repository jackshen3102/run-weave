import { createHash, randomUUID } from "node:crypto";
import { settingText } from "@runweave/config-node";
import { parseTerminalChildProjectId } from "@runweave/shared/terminal/project-context";
import type {
  ScheduledExecutionPolicy,
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import type { TerminalQuickInputService } from "../terminal/quick-input/service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { probeCodexCatalog } from "../agent-team/model-catalog/codex";
import { ScheduledTaskError, scheduledTaskErrorFromStorage } from "./errors";
import type { ScheduledTaskStore } from "./storage/store";

export async function startQuickInputRun(args: {
  quickInputId: string;
  projectId: string;
  expectedInputUpdatedAt: string;
  idempotencyKey: string;
  quickInputs: TerminalQuickInputService;
  store: ScheduledTaskStore;
  manager: TerminalSessionManager;
  requireProject: (id: string) => { path: string | null };
  requireProvider: (provider: string) => void;
  requireContinuation: (
    provider: string,
    policy: ScheduledTask["continuationPolicy"],
  ) => void;
  requireExecutionPolicy: (
    provider: string,
    policy: ScheduledExecutionPolicy,
  ) => void;
  wake: () => void;
}): Promise<ScheduledRun> {
  const {
    quickInputId,
    projectId,
    expectedInputUpdatedAt,
    idempotencyKey,
    store,
  } = args;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ quickInputId, projectId, expectedInputUpdatedAt }))
    .digest("hex");
  try {
    const existing = await store.findQuickInputRun(
      quickInputId,
      projectId,
      idempotencyKey,
      requestHash,
    );
    if (existing) return existing;
  } catch (error) {
    throw scheduledTaskErrorFromStorage(error);
  }
  const input = await args.quickInputs.getById(quickInputId);
  if (!input)
    throw new ScheduledTaskError(
      "quick_input_not_found",
      404,
      "Quick input not found",
    );
  if (input.updatedAt !== expectedInputUpdatedAt)
    throw new ScheduledTaskError(
      "input_changed",
      409,
      "Quick input changed; refresh before running",
    );
  const project = args.requireProject(projectId);
  const parentProjectId = args.manager.resolveParentProjectId(projectId);
  if (input.projectId && input.projectId !== parentProjectId)
    throw new ScheduledTaskError(
      "context_unavailable",
      409,
      "Quick input belongs to another project",
    );
  const parent = args.manager.getProject(parentProjectId);
  if (!parent?.name)
    throw new ScheduledTaskError(
      "context_unavailable",
      409,
      "Parent project is unavailable",
    );
  args.requireProvider("codex");
  const executionPolicy =
    settingText("scheduledTasks.quickInputDefaults.executionPolicy")?.trim() ||
    "full-access";
  if (!["sandbox", "auto-review", "full-access"].includes(executionPolicy))
    throw new ScheduledTaskError(
      "config_required",
      409,
      "Background execution policy is invalid",
    );
  args.requireExecutionPolicy(
    "codex",
    executionPolicy as ScheduledExecutionPolicy,
  );
  const continuationMode =
    settingText("scheduledTasks.quickInputDefaults.continuationMode")?.trim() ||
    "bounded";
  if (continuationMode !== "off" && continuationMode !== "bounded")
    throw new ScheduledTaskError(
      "config_required",
      409,
      "Background continuation policy is invalid",
    );
  const continuationPolicy: ScheduledTask["continuationPolicy"] = {
    mode: continuationMode,
  };
  args.requireContinuation("codex", continuationPolicy);
  const model = settingText("scheduledTasks.quickInputDefaults.model")?.trim();
  const effort = settingText(
    "scheduledTasks.quickInputDefaults.effort",
  )?.trim();
  if (!model)
    throw new ScheduledTaskError(
      "config_required",
      409,
      "Choose a background model before running quick inputs",
    );
  let catalog;
  try {
    catalog = await probeCodexCatalog(process.env);
  } catch {
    throw new ScheduledTaskError(
      "model_unavailable",
      409,
      "Codex model catalog is unavailable",
    );
  }
  const selected = catalog.models.find((item) => item.id === model);
  if (!selected || (effort && !selected.reasoningEfforts.includes(effort)))
    throw new ScheduledTaskError(
      "model_unavailable",
      409,
      "Selected background model or effort is unavailable",
    );
  const now = new Date().toISOString();
  const task: ScheduledTask = {
    id: randomUUID(),
    revision: 1,
    name: input.title.trim() || "创建 github pr",
    projectId,
    provider: "codex",
    prompt: input.data,
    model,
    ...(effort ? { effort } : {}),
    executionPolicy: executionPolicy as ScheduledExecutionPolicy,
    continuationPolicy,
    schedule: { kind: "once", timezone: "UTC", runAt: now },
    misfirePolicy: { mode: "skip" },
    origin: {
      kind: "quick-input",
      quickInputId,
      projectName: parent.name,
      worktreeName:
        parseTerminalChildProjectId(projectId)?.worktreeName ?? null,
    },
    enabled: false,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  try {
    const run = await store.createQuickInputRun(
      task,
      parentProjectId,
      project.path!,
      idempotencyKey,
      requestHash,
    );
    args.wake();
    return run;
  } catch (error) {
    throw scheduledTaskErrorFromStorage(error);
  }
}
