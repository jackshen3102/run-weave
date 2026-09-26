import { configuration, settingText } from "@runweave/config-node";
export const TERMINAL_APP_SERVER_ENV_KEYS = [
  "RUNWEAVE_APP_SERVER_TOKEN",
  "RUNWEAVE_APP_SERVER_URL",
] as const;

export const TERMINAL_RUNTIME_ENV_KEYS = [
  "RUNWEAVE_RUNTIME_KIND",
  "RUNWEAVE_RUNTIME_INSTANCE_ID",
  "RUNWEAVE_RUNTIME_CONFIG_ROOT",
  "RUNWEAVE_RUNTIME_TMUX_BINARY",
  "RUNWEAVE_TERMINAL_SESSION_ID",
  "RUNWEAVE_TERMINAL_PANEL_ID",
  "RUNWEAVE_PROJECT_ID",
  "RUNWEAVE_AGENT_TEAM_RUN_ID",
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
    agentTeamRunId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const context = configuration().context;
  const appServerEnabled = settingText("appServer.discovery") !== "disabled";
  return {
    RUNWEAVE_RUNTIME_KIND: context.kind,
    RUNWEAVE_RUNTIME_INSTANCE_ID: context.instanceId,
    RUNWEAVE_RUNTIME_CONFIG_ROOT: context.configRoot,
    RUNWEAVE_RUNTIME_TMUX_BINARY: settingText("terminal.tmux.binary") ?? "tmux",
    RUNWEAVE_TERMINAL_SESSION_ID: identity.terminalSessionId,
    RUNWEAVE_TERMINAL_PANEL_ID: identity.terminalPanelId,
    RUNWEAVE_PROJECT_ID: identity.projectId,
    RUNWEAVE_AGENT_TEAM_RUN_ID: identity.agentTeamRunId ?? undefined,
    RUNWEAVE_TMUX_SESSION_NAME: identity.tmuxSessionName,
    RUNWEAVE_TOOLKIT_PLUGIN_ROOT: env.RUNWEAVE_TOOLKIT_PLUGIN_ROOT,
    RUNWEAVE_HOOK_ENDPOINT: env.RUNWEAVE_HOOK_ENDPOINT,
    RUNWEAVE_COMPLETION_HOOK_ENDPOINT:
      env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT,
    RUNWEAVE_HOOK_DEBUG_LOG: env.RUNWEAVE_HOOK_DEBUG_LOG,
    RUNWEAVE_HOOK_TOKEN: env.RUNWEAVE_HOOK_TOKEN,
    RUNWEAVE_BASE_URL: env.RUNWEAVE_BASE_URL,
    RUNWEAVE_BACKEND_PORT: env.RUNWEAVE_BACKEND_PORT,
    RUNWEAVE_CONFIG_FILE: undefined,
    RUNWEAVE_DESKTOP_CHANNEL: env.RUNWEAVE_DESKTOP_CHANNEL,
    RUNWEAVE_APP_SERVER_TOKEN: appServerEnabled ? env.RUNWEAVE_APP_SERVER_TOKEN : undefined,
    RUNWEAVE_APP_SERVER_URL: appServerEnabled ? env.RUNWEAVE_APP_SERVER_URL : undefined,
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
