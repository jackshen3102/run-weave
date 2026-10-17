import { CONFIGURATION_FIELDS } from "@runweave/shared/configuration";
export function isNpmProcessEnvName(name: string): boolean {
  return name.toLowerCase().startsWith("npm_");
}

function removeNpmProcessEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (isNpmProcessEnvName(name)) {
      delete env[name];
    }
  }
}

export function sanitizeTerminalProcessEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  removeNpmProcessEnv(sanitized);
  for (const field of CONFIGURATION_FIELDS) if (field.sensitive) for (const key of field.environmentKeys) delete sanitized[key];
  delete sanitized.RUNWEAVE_ACCESS_TOKEN;
  delete sanitized.RUNWEAVE_CONFIG_FILE;
  delete sanitized.NO_COLOR;
  delete sanitized.ELECTRON_RUN_AS_NODE;
  delete sanitized.FRONTEND_DIST_DIR;

  if (isDisabledColorFlag(sanitized.FORCE_COLOR)) {
    delete sanitized.FORCE_COLOR;
  }
  if (sanitized.CLICOLOR?.trim() === "0") {
    delete sanitized.CLICOLOR;
  }

  return sanitized;
}

export function sanitizeCurrentTerminalProcessEnv(): void {
  // A Backend started from an Agent terminal is a service, not that terminal's
  // Agent. Its provider probes must never inherit ownership of the caller's TUI.
  for (const key of [
    "RUNWEAVE_TERMINAL_SESSION_ID",
    "RUNWEAVE_TERMINAL_PANEL_ID",
    "RUNWEAVE_TERMINAL_AGENT_OPERATION_ID",
    "RUNWEAVE_TMUX_SESSION_NAME",
    "RUNWEAVE_CODEX_CONTEXT_PATH",
    "RUNWEAVE_CODEX_CONTEXT_GENERATION",
    "RUNWEAVE_RUNTIME_KIND",
    "RUNWEAVE_RUNTIME_INSTANCE_ID",
    "RUNWEAVE_RUNTIME_CONFIG_ROOT",
    "RUNWEAVE_RUNTIME_TMUX_BINARY",
    "RUNWEAVE_CODEX_BINARY",
    "RUNWEAVE_PROJECT_ID",
    "RUNWEAVE_BROWSER_GROUP_ID",
    "RUNWEAVE_SCHEDULED_TASK_RUN_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "TMUX",
    "TMUX_PANE",
  ]) delete process.env[key];
  removeNpmProcessEnv(process.env);
  delete process.env.NO_COLOR;
  delete process.env.ELECTRON_RUN_AS_NODE;
  if (isDisabledColorFlag(process.env.FORCE_COLOR)) {
    delete process.env.FORCE_COLOR;
  }
  if (process.env.CLICOLOR?.trim() === "0") {
    delete process.env.CLICOLOR;
  }
}

function isDisabledColorFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false";
}
