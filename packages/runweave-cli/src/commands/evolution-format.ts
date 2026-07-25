import type {
  EvolutionBudget,
  EvolutionProviderAvailability,
  EvolutionRun,
  EvolutionSchedule,
} from "@runweave/shared/evolution";

export interface EvolutionProvidersResponse {
  runtimeAvailable: boolean;
  providers: EvolutionProviderAvailability[];
}

export function formatRun(run: EvolutionRun): string {
  return [
    `Run: ${run.runId}`,
    `Scope: ${run.learningScopeId}`,
    `Stage: ${run.stage}`,
    `Outcome: ${run.outcome ?? "pending"}`,
    `Trigger: ${formatTrigger(run)}`,
    `Profile: ${run.profile}`,
    `Provider policy: ${run.providerPolicy}`,
    `Attempt: ${run.attempt}`,
    `Created: ${run.createdAt}`,
    `Started: ${run.startedAt ?? "not started"}`,
    `Completed: ${run.completedAt ?? "not completed"}`,
    `Data range: after=${run.dataRange.afterWatermark ?? "beginning"}, at-or-before=${run.dataRange.atOrBefore}`,
    `Budget: ${formatBudget(run.budget)}`,
  ].join("\n");
}

export function formatRunList(runs: EvolutionRun[]): string {
  if (runs.length === 0) return "No evolution runs.";
  return runs
    .map(
      (run) =>
        `${run.runId}  ${run.stage}  ${run.outcome ?? "-"}  ${run.profile}/${run.providerPolicy}  scope=${run.learningScopeId}  created=${run.createdAt}`,
    )
    .join("\n");
}

export function formatProviders(response: EvolutionProvidersResponse): string {
  return [
    `Evolution runtime: ${response.runtimeAvailable ? "available" : "unavailable"}`,
    ...response.providers.map(
      (provider) =>
        `${provider.provider}: ${provider.available ? "available" : "unavailable"}; binary=${provider.binaryAvailable}; authenticated=${provider.authenticated}; version=${provider.version ?? "-"}; reason=${provider.reason ?? "-"}`,
    ),
  ].join("\n");
}

export function formatSchedule(schedule: EvolutionSchedule): string {
  return [
    `Schedule: ${schedule.scheduleId}`,
    `Name: ${schedule.name}`,
    `Scope: ${schedule.learningScopeId}`,
    `Enabled: ${schedule.enabled}`,
    `Cron: ${schedule.cronExpression}`,
    `Timezone: ${schedule.timezone}`,
    `Profile: ${schedule.profile}`,
    `Provider policy: ${schedule.providerPolicy}`,
    `Data window: ${schedule.dataWindow}`,
    `Next due: ${schedule.nextDueAt ?? "not scheduled"}`,
    `Last due: ${schedule.lastDueAt ?? "never"}`,
    `Last run: ${schedule.lastRunId ?? "none"}`,
    `Budget: ${formatBudget(schedule.budget)}`,
  ].join("\n");
}

export function formatScheduleList(schedules: EvolutionSchedule[]): string {
  if (schedules.length === 0) return "No evolution schedules.";
  return schedules
    .map(
      (schedule) =>
        `${schedule.scheduleId}  ${schedule.enabled ? "enabled" : "disabled"}  ${schedule.name}  ${schedule.cronExpression} ${schedule.timezone}  next=${schedule.nextDueAt ?? "-"}  scope=${schedule.learningScopeId}`,
    )
    .join("\n");
}

function formatTrigger(run: EvolutionRun): string {
  if (run.trigger.type === "manual") {
    return `manual requestedBy=${run.trigger.requestedBy}`;
  }
  if (run.trigger.type === "schedule") {
    return `schedule scheduleId=${run.trigger.scheduleId} dueAt=${run.trigger.dueAt}`;
  }
  return `event eventKey=${run.trigger.eventKey} sourceRef=${run.trigger.sourceRef}`;
}

function formatBudget(budget: EvolutionBudget): string {
  return [
    `agents=${budget.maxAgents}`,
    `turns=${budget.maxModelTurns}`,
    `wallMs=${budget.maxWallTimeMs}`,
    `contextBytes=${budget.maxContextBytes}`,
    `tools=${budget.maxToolCalls}`,
    `replays=${budget.maxReplays}`,
  ].join(", ");
}
