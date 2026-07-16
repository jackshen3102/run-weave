export const TERMINAL_APP_SERVER_ENV_KEYS = [
  "RUNWEAVE_APP_SERVER_DISCOVERY",
  "RUNWEAVE_APP_SERVER_HOME",
  "RUNWEAVE_APP_SERVER_STATE_DIR",
  "RUNWEAVE_APP_SERVER_TOKEN",
  "RUNWEAVE_APP_SERVER_URL",
] as const;

export const TERMINAL_RUNTIME_ENV_KEYS = [
  "RUNWEAVE_TERMINAL_SESSION_ID",
  "RUNWEAVE_TERMINAL_PANEL_ID",
  "RUNWEAVE_PROJECT_ID",
  "RUNWEAVE_TMUX_SESSION_NAME",
  "RUNWEAVE_TOOLKIT_PLUGIN_ROOT",
  "RUNWEAVE_HOOK_ENDPOINT",
  "RUNWEAVE_COMPLETION_HOOK_ENDPOINT",
  "RUNWEAVE_HOOK_DEBUG_LOG",
  "RUNWEAVE_HOOK_TOKEN",
  "RUNWEAVE_BASE_URL",
  "RUNWEAVE_BACKEND_PORT",
  "RUNWEAVE_CONFIG_FILE",
  "RUNWEAVE_DESKTOP_CHANNEL",
  ...TERMINAL_APP_SERVER_ENV_KEYS,
] as const;

export function buildTerminalRuntimeEnvironment(
  identity: {
    terminalSessionId: string;
    projectId: string;
    terminalPanelId?: string;
    tmuxSessionName?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return {
    RUNWEAVE_TERMINAL_SESSION_ID: identity.terminalSessionId,
    RUNWEAVE_TERMINAL_PANEL_ID: identity.terminalPanelId,
    RUNWEAVE_PROJECT_ID: identity.projectId,
    RUNWEAVE_TMUX_SESSION_NAME: identity.tmuxSessionName,
    RUNWEAVE_TOOLKIT_PLUGIN_ROOT: env.RUNWEAVE_TOOLKIT_PLUGIN_ROOT,
    RUNWEAVE_HOOK_ENDPOINT: env.RUNWEAVE_HOOK_ENDPOINT,
    RUNWEAVE_COMPLETION_HOOK_ENDPOINT:
      env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT,
    RUNWEAVE_HOOK_DEBUG_LOG: env.RUNWEAVE_HOOK_DEBUG_LOG,
    RUNWEAVE_HOOK_TOKEN: env.RUNWEAVE_HOOK_TOKEN,
    RUNWEAVE_BASE_URL: env.RUNWEAVE_BASE_URL,
    RUNWEAVE_BACKEND_PORT: env.RUNWEAVE_BACKEND_PORT,
    RUNWEAVE_CONFIG_FILE: env.RUNWEAVE_CONFIG_FILE,
    RUNWEAVE_DESKTOP_CHANNEL: env.RUNWEAVE_DESKTOP_CHANNEL,
    RUNWEAVE_APP_SERVER_DISCOVERY: env.RUNWEAVE_APP_SERVER_DISCOVERY,
    RUNWEAVE_APP_SERVER_HOME: env.RUNWEAVE_APP_SERVER_HOME,
    RUNWEAVE_APP_SERVER_STATE_DIR: env.RUNWEAVE_APP_SERVER_STATE_DIR,
    RUNWEAVE_APP_SERVER_TOKEN: env.RUNWEAVE_APP_SERVER_TOKEN,
    RUNWEAVE_APP_SERVER_URL: env.RUNWEAVE_APP_SERVER_URL,
  };
}

export function buildTmuxSessionRuntimeEnvironment(
  identity: {
    terminalSessionId: string;
    projectId: string;
    tmuxSessionName: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const terminalEnv = buildTerminalRuntimeEnvironment(identity, env);
  return Object.fromEntries(
    TERMINAL_RUNTIME_ENV_KEYS.filter(
      (key) => key !== "RUNWEAVE_TERMINAL_PANEL_ID",
    ).map((key) => [key, terminalEnv[key]]),
  );
}
