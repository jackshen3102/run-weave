import type { ScheduledTaskCapabilities } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { logger } from "../logging/index";
import { probeScheduledProviders } from "./providers/capabilities";
import { ScheduledTaskRuntime } from "./runtime";
import { ScheduledTaskService } from "./service";
import { ScheduledTaskStore } from "./storage/store";
import { ScheduledTerminalAttachment } from "./terminal-attachment";
import type { TerminalSessionCreationOptions } from "../terminal/application/create-session";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024;

export interface ScheduledTaskSubsystem {
  service: ScheduledTaskService;
  runtime: ScheduledTaskRuntime | null;
  store: ScheduledTaskStore | null;
}

export async function createScheduledTaskSubsystem(params: {
  databasePath: string;
  terminalSessionManager: TerminalSessionManager;
  env?: NodeJS.ProcessEnv;
  terminalOptions: TerminalSessionCreationOptions;
}): Promise<ScheduledTaskSubsystem> {
  const env = params.env ?? process.env;
  const enabled = env.RUNWEAVE_SCHEDULED_TASKS_ENABLED?.trim().toLowerCase() !== "false";
  const timeoutMs = positiveInteger(env.RUNWEAVE_SCHEDULED_TASK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = positiveInteger(env.RUNWEAVE_SCHEDULED_TASK_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
  const providerProbe = await probeScheduledProviders(env);
  const tmuxAvailable =
    (await params.terminalOptions.tmuxService?.isAvailable()) ?? false;
  if (!tmuxAvailable) {
    providerProbe.adapters.delete("codex");
    const codex = providerProbe.capabilities.find(
      (item) => item.provider === "codex",
    );
    if (codex) {
      codex.available = false;
      codex.reason =
        "tmux is unavailable, so persistent threads cannot be opened in a terminal";
    }
  }
  const capabilities: ScheduledTaskCapabilities = {
    enabled,
    ...(enabled ? {} : { reason: "Scheduled tasks are disabled by Backend configuration" }),
    providers: providerProbe.capabilities,
    limits: { maxConcurrentRuns: 1, timeoutMs, maxOutputBytes },
  };
  try {
    const store = await ScheduledTaskStore.create({ databasePath: params.databasePath, env });
    const runtime = new ScheduledTaskRuntime(store, params.terminalSessionManager, providerProbe.adapters, enabled, { timeoutMs, maxOutputBytes });
    await runtime.initialize();
    const service = new ScheduledTaskService(store, params.terminalSessionManager, capabilities);
    service.attachRuntime(runtime);
    service.attachTerminalAttachment(
      new ScheduledTerminalAttachment(
        store,
        params.terminalSessionManager,
        params.terminalOptions,
      ),
    );
    return { service, runtime, store };
  } catch (error) {
    logger.error("scheduled-tasks.initialize.failed", {
      component: "scheduled-tasks",
      message: "Scheduled task subsystem initialization failed",
      error,
    });
    return {
      service: new ScheduledTaskService(null, params.terminalSessionManager, capabilities, "Scheduled task storage failed to initialize"),
      runtime: null,
      store: null,
    };
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
