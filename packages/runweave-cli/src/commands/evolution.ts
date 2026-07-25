import type {
  AnalysisProfile,
  CreateEvolutionRunRequest,
  CreateEvolutionScheduleRequest,
  EvolutionBudget,
  EvolutionRun,
  EvolutionRunStage,
  EvolutionSchedule,
  ProviderPolicy,
  UpdateEvolutionScheduleRequest,
} from "@runweave/shared/evolution";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import {
  type AuthContext,
  resolveAuthContext,
} from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";
import {
  formatProviders,
  formatRun,
  formatRunList,
  formatSchedule,
  formatScheduleList,
  type EvolutionProvidersResponse,
} from "./evolution-format.js";

type EvolutionIo = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
};

interface EvolutionRunListResponse {
  runs: EvolutionRun[];
}

interface EvolutionScheduleListResponse {
  schedules: EvolutionSchedule[];
}

const EVOLUTION_USAGE =
  "Usage: rw evolution <run|list|get|cancel|retry|providers|schedule> [options]";
const SCHEDULE_USAGE =
  "Usage: rw evolution schedule <list|create|update|delete> [options]";

export async function runEvolutionCommand(
  subcommand: string | undefined,
  args: string[],
  io: EvolutionIo,
): Promise<void> {
  if (
    subcommand !== "run" &&
    subcommand !== "list" &&
    subcommand !== "get" &&
    subcommand !== "cancel" &&
    subcommand !== "retry" &&
    subcommand !== "providers" &&
    subcommand !== "schedule"
  ) {
    throw new CliError(EVOLUTION_USAGE, 2);
  }

  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const auth = await resolveEvolutionAuth(parsed.options, io.env);

  if (subcommand === "run") {
    const request = buildCreateRunRequest(parsed.options);
    const run = await requestEvolution(() =>
      auth.requestJson<EvolutionRun>("/api/evolution/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    writeOutput(io.stdout, mode, mode === "json" ? run : formatRun(run));
    return;
  }

  if (subcommand === "list") {
    const response = await requestEvolution(() =>
      auth.requestJson<EvolutionRunListResponse>(
        `/api/evolution/runs${buildQueryString({
          learningScopeId: getStringOption(parsed.options, "learning-scope-id"),
          stage: resolveRunStage(getStringOption(parsed.options, "stage")),
          limit: resolveIntegerOption(parsed.options, "limit", 1, 200),
        })}`,
      ),
    );
    writeOutput(
      io.stdout,
      mode,
      mode === "json" ? response : formatRunList(response.runs),
    );
    return;
  }

  if (subcommand === "providers") {
    const response = await requestEvolution(() =>
      auth.requestJson<EvolutionProvidersResponse>("/api/evolution/providers"),
    );
    writeOutput(
      io.stdout,
      mode,
      mode === "json" ? response : formatProviders(response),
    );
    return;
  }

  if (subcommand === "schedule") {
    await runScheduleCommand(
      parsed.positionals,
      parsed.options,
      mode,
      auth,
      io,
    );
    return;
  }

  const runId = requirePositionalId(parsed.positionals, "run id");
  const route = `/api/evolution/runs/${encodeURIComponent(runId)}`;
  const run = await requestEvolution(() => {
    if (subcommand === "get") {
      return auth.requestJson<EvolutionRun>(route);
    }
    return auth.requestJson<EvolutionRun>(`${route}/${subcommand}`, {
      method: "POST",
    });
  });
  writeOutput(io.stdout, mode, mode === "json" ? run : formatRun(run));
}

async function runScheduleCommand(
  positionals: string[],
  options: Record<string, string | boolean>,
  mode: "json" | "plain",
  auth: AuthContext,
  io: EvolutionIo,
): Promise<void> {
  const action = positionals[0];
  if (
    action !== "list" &&
    action !== "create" &&
    action !== "update" &&
    action !== "delete"
  ) {
    throw new CliError(SCHEDULE_USAGE, 2);
  }

  if (action === "list") {
    const response = await requestEvolution(() =>
      auth.requestJson<EvolutionScheduleListResponse>(
        `/api/evolution/schedules${buildQueryString({
          learningScopeId: getStringOption(options, "learning-scope-id"),
        })}`,
      ),
    );
    writeOutput(
      io.stdout,
      mode,
      mode === "json" ? response : formatScheduleList(response.schedules),
    );
    return;
  }

  if (action === "create") {
    const request = buildCreateScheduleRequest(options);
    const schedule = await requestEvolution(() =>
      auth.requestJson<EvolutionSchedule>("/api/evolution/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    writeOutput(
      io.stdout,
      mode,
      mode === "json" ? schedule : formatSchedule(schedule),
    );
    return;
  }

  const scheduleId = positionals[1];
  if (!scheduleId) {
    throw new CliError(`Missing schedule id. ${SCHEDULE_USAGE}`, 2);
  }
  const route = `/api/evolution/schedules/${encodeURIComponent(scheduleId)}`;

  if (action === "delete") {
    await requestEvolution(() => auth.requestVoid(route, { method: "DELETE" }));
    writeOutput(
      io.stdout,
      mode,
      mode === "json"
        ? { scheduleId, deleted: true }
        : `Deleted evolution schedule ${scheduleId}`,
    );
    return;
  }

  const request = buildUpdateScheduleRequest(options);
  if (Object.keys(request).length === 0) {
    throw new CliError(
      "Schedule update requires at least one schedule option",
      2,
    );
  }
  const schedule = await requestEvolution(() =>
    auth.requestJson<EvolutionSchedule>(route, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  writeOutput(
    io.stdout,
    mode,
    mode === "json" ? schedule : formatSchedule(schedule),
  );
}

async function resolveEvolutionAuth(
  options: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): Promise<AuthContext> {
  try {
    return await resolveAuthContext({
      profileName: getStringOption(options, "profile"),
      backendPort: getStringOption(options, "backend-port"),
      env,
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `Evolution authentication failed: ${formatError(error)}`,
      1,
    );
  }
}

async function requestEvolution<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `Evolution Backend request failed: ${formatError(error)}`,
      1,
    );
  }
}

function buildCreateRunRequest(
  options: Record<string, string | boolean>,
): CreateEvolutionRunRequest {
  const budget = buildBudget(options);
  const afterWatermark = getStringOption(options, "after-watermark");
  const atOrBefore = getStringOption(options, "at-or-before");
  const profile = resolveProfile(getStringOption(options, "analysis-profile"));
  const providerPolicy = resolveProviderPolicy(
    getStringOption(options, "provider-policy"),
  );
  return {
    projectId: requireStringOption(options, "project-id"),
    ...(profile ? { profile } : {}),
    ...(providerPolicy ? { providerPolicy } : {}),
    ...(budget ? { budget } : {}),
    ...(afterWatermark || atOrBefore
      ? {
          dataRange: {
            ...(afterWatermark ? { afterWatermark } : {}),
            ...(atOrBefore ? { atOrBefore } : {}),
          },
        }
      : {}),
  };
}

function buildCreateScheduleRequest(
  options: Record<string, string | boolean>,
): CreateEvolutionScheduleRequest {
  const optional = buildScheduleOptions(options);
  return {
    projectId: requireStringOption(options, "project-id"),
    name: requireStringOption(options, "name"),
    cronExpression: requireStringOption(options, "cron"),
    timezone: requireStringOption(options, "timezone"),
    ...optional,
  };
}

function buildUpdateScheduleRequest(
  options: Record<string, string | boolean>,
): UpdateEvolutionScheduleRequest {
  const name = getStringOption(options, "name");
  const cronExpression = getStringOption(options, "cron");
  const timezone = getStringOption(options, "timezone");
  return {
    ...(name ? { name } : {}),
    ...(cronExpression ? { cronExpression } : {}),
    ...(timezone ? { timezone } : {}),
    ...buildScheduleOptions(options),
  };
}

function buildScheduleOptions(
  options: Record<string, string | boolean>,
): UpdateEvolutionScheduleRequest {
  const enabled = resolveOptionalBoolean(
    getStringOption(options, "enabled"),
    "--enabled",
  );
  const profile = resolveProfile(getStringOption(options, "analysis-profile"));
  const providerPolicy = resolveProviderPolicy(
    getStringOption(options, "provider-policy"),
  );
  const budget = buildBudget(options);
  const dataWindow = getStringOption(options, "data-window");
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(profile ? { profile } : {}),
    ...(providerPolicy ? { providerPolicy } : {}),
    ...(budget ? { budget } : {}),
    ...(dataWindow ? { dataWindow } : {}),
  };
}

function resolveOptionalBoolean(
  value: string | undefined,
  optionName: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError(`${optionName} must be true or false`, 2);
}

function buildBudget(
  options: Record<string, string | boolean>,
): Partial<EvolutionBudget> | undefined {
  const budget: Partial<EvolutionBudget> = {
    maxAgents: resolveIntegerOption(options, "max-agents", 1),
    maxModelTurns: resolveIntegerOption(options, "max-model-turns", 1),
    maxWallTimeMs: resolveIntegerOption(options, "max-wall-time-ms", 1),
    maxContextBytes: resolveIntegerOption(options, "max-context-bytes", 1),
    maxToolCalls: resolveIntegerOption(options, "max-tool-calls", 1),
    maxReplays: resolveIntegerOption(options, "max-replays", 0),
  };
  const definedBudget = Object.fromEntries(
    Object.entries(budget).filter(([, value]) => value !== undefined),
  ) as Partial<EvolutionBudget>;
  return Object.keys(definedBudget).length > 0 ? definedBudget : undefined;
}

function resolveProfile(
  value: string | undefined,
): AnalysisProfile | undefined {
  if (value === undefined) return undefined;
  if (value === "quick" || value === "standard" || value === "deep") {
    return value;
  }
  throw new CliError(
    "--analysis-profile must be one of: quick, standard, deep",
    2,
  );
}

function resolveProviderPolicy(
  value: string | undefined,
): ProviderPolicy | undefined {
  if (value === undefined) return undefined;
  if (
    value === "auto" ||
    value === "codex" ||
    value === "trae" ||
    value === "mixed"
  ) {
    return value;
  }
  throw new CliError(
    "--provider-policy must be one of: auto, codex, trae, mixed",
    2,
  );
}

function resolveRunStage(
  value: string | undefined,
): EvolutionRunStage | undefined {
  if (value === undefined) return undefined;
  const stages: EvolutionRunStage[] = [
    "queued",
    "snapshotting",
    "segmenting",
    "independent_analysis",
    "cross_questioning",
    "adjudicating",
    "novelty_check",
    "validating",
    "completed",
    "no_material_novelty",
    "partial",
    "failed",
    "cancelled",
    "blocked",
  ];
  if (stages.includes(value as EvolutionRunStage)) {
    return value as EvolutionRunStage;
  }
  throw new CliError(`Invalid evolution run stage: ${value}`, 2);
}

function resolveIntegerOption(
  options: Record<string, string | boolean>,
  name: string,
  minimum: number,
  maximum?: number,
): number | undefined {
  const value = getStringOption(options, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    (maximum !== undefined && parsed > maximum)
  ) {
    const range =
      maximum === undefined
        ? `at least ${minimum}`
        : `between ${minimum} and ${maximum}`;
    throw new CliError(`--${name} must be an integer ${range}`, 2);
  }
  return parsed;
}

function requirePositionalId(positionals: string[], label: string): string {
  const value = positionals[0];
  if (!value) throw new CliError(`Missing ${label}`, 2);
  return value;
}

function buildQueryString(
  values: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
