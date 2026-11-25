/* global module, process */

function parseTmuxSocketPath(value) {
  if (!value) {
    return null;
  }
  const socketPath = String(value).split(",")[0]?.trim();
  return socketPath || null;
}

function getCommandBasename(command) {
  const normalized = String(command || "")
    .trim()
    .replace(/\\+/g, "/");
  if (!normalized) {
    return null;
  }
  const basename = normalized.split("/").filter(Boolean).at(-1) || normalized;
  return basename || null;
}

function readTmuxSessionEnv(spawnSync) {
  const sessionName = process.env.RUNWEAVE_TMUX_SESSION_NAME;
  const socketPath = parseTmuxSocketPath(process.env.TMUX);
  if (!sessionName || !socketPath) {
    return { refreshed: false, reason: "missing_tmux_env" };
  }

  const result = spawnSync(
    process.env.RUNWEAVE_RUNTIME_TMUX_BINARY || "tmux",
    ["-S", socketPath, "show-environment", "-t", sessionName],
    {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 256 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    return {
      refreshed: false,
      reason: "tmux_show_environment_failed",
      error: result.error instanceof Error ? result.error.message : undefined,
      status: result.status,
    };
  }

  const env = {};
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("-RUNWEAVE_")) {
      delete process.env[line.slice(1)];
      continue;
    }
    if (!line.startsWith("RUNWEAVE_")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    env[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  return {
    refreshed: Object.keys(env).length > 0,
    sessionName,
    socketPath,
    keys: Object.keys(env).sort(),
  };
}

function readTmuxPaneContext(spawnSync) {
  const socketPath = parseTmuxSocketPath(process.env.TMUX);
  const tmuxPaneId = process.env.TMUX_PANE;
  if (!socketPath || !tmuxPaneId) {
    return {
      commandName: null,
      panelId: null,
      resolved: false,
      reason: "missing_tmux_context",
    };
  }
  const separator = "__RUNWEAVE_METADATA_FIELD__";
  let result;
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    result = spawnSync(
      process.env.RUNWEAVE_RUNTIME_TMUX_BINARY || "tmux",
      [
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        tmuxPaneId,
        [
          "#{@runweave_agent_prepare_command}",
          "#{@runweave_agent_prepare_exit}",
          "#{@runweave_command}",
          "#{pane_current_command}",
          "#{@runweave_panel_id}",
          "#{session_name}",
        ].join(separator),
      ],
      {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 32 * 1024,
      },
    );
    if (!result.error && result.status === 0) {
      break;
    }
  }
  if (!result || result.error || result.status !== 0) {
    return {
      commandName: null,
      panelId: null,
      resolved: false,
      reason: "tmux_display_message_failed",
      attempts,
      status: result?.status ?? null,
      error: result?.error instanceof Error ? result.error.message : null,
    };
  }
  const [
    agentPrepareCommand = "",
    agentPrepareExit = "",
    runweaveCommand = "",
    paneCommand = "",
    panelId = "",
    sessionName = "",
  ] = String(result.stdout || "")
    .replace(/\r?\n$/, "")
    .split(separator);
  const normalizedPaneCommand = getCommandBasename(paneCommand);
  const paneAtInteractivePrompt = ["bash", "fish", "sh", "zsh"].includes(
    normalizedPaneCommand,
  );
  const pendingAgentCommand =
    agentPrepareExit.startsWith("pending:") &&
    (Boolean(runweaveCommand.trim()) || !paneAtInteractivePrompt)
      ? getCommandBasename(agentPrepareCommand)
      : null;
  return {
    commandName:
      pendingAgentCommand ||
      getCommandBasename(runweaveCommand) ||
      getCommandBasename(paneCommand),
    panelId: panelId.trim() || null,
    sessionName: sessionName.trim() || null,
    resolved: true,
    reason: null,
    attempts,
  };
}

module.exports = { getCommandBasename, parseTmuxSocketPath, readTmuxPaneContext, readTmuxSessionEnv };
