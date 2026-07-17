/* global module, process */

const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);
const COMPLETION_REASONS = new Set([
  "hook_stop",
  "notify",
  "ai_process_exit",
  "manual",
]);

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
      process.env.TMUX_BINARY || "tmux",
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
    resolved: true,
    reason: null,
    attempts,
  };
}

function normalizeSummaryText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 8000
    ? `${trimmed.slice(0, 8000)}\n...[truncated]`
    : trimmed;
}

function extractCompletionSummary(payload) {
  const directKeys = [
    "summary",
    "message",
    "last_message",
    "lastMessage",
    "lastAssistantMessage",
    "assistant_message",
    "assistantMessage",
    "response",
    "output",
    "text",
    "content",
  ];
  for (const key of directKeys) {
    const normalized = normalizeSummaryText(payload?.[key]);
    if (normalized) {
      return normalized;
    }
  }
  const transcript = Array.isArray(payload?.transcript)
    ? payload.transcript
    : null;
  if (transcript) {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const item = transcript[index];
      const role = String(item?.role || item?.type || "").toLowerCase();
      if (role && !role.includes("assistant") && !role.includes("agent")) {
        continue;
      }
      const normalized =
        normalizeSummaryText(item?.content) ||
        normalizeSummaryText(item?.text) ||
        normalizeSummaryText(item?.message);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function extractUserPrompt(payload) {
  for (const key of [
    "prompt",
    "query",
    "user_prompt",
    "userPrompt",
    "message",
  ]) {
    const normalized = normalizeSummaryText(payload?.[key]);
    if (normalized) return normalized;
  }
  return null;
}

function extractToolHook(payload) {
  const toolUseId =
    payload?.tool_use_id ?? payload?.toolUseId ?? payload?.tool_call_id;
  const toolName = payload?.tool_name ?? payload?.toolName ?? payload?.name;
  return {
    toolUseId:
      typeof toolUseId === "string" && toolUseId.trim()
        ? toolUseId.trim()
        : null,
    toolName:
      typeof toolName === "string" && toolName.trim() ? toolName.trim() : null,
    toolInput: payload?.tool_input ?? payload?.input,
    toolResult:
      payload?.tool_response ?? payload?.tool_result ?? payload?.output,
  };
}

function parseArgs(argv) {
  const args = { source: "unknown", reason: "hook_stop", commandName: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source" && argv[index + 1]) {
      args.source = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--reason" && argv[index + 1]) {
      args.reason = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--command-name" && argv[index + 1]) {
      args.commandName = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function parsePayload(raw) {
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readHookEvent(payload) {
  return (
    payload.hook_event_name ??
    payload.hookEventName ??
    payload.eventName ??
    payload.event ??
    "Unknown"
  );
}

function readThreadId(payload) {
  const raw =
    payload.threadId ??
    payload.thread_id ??
    payload.sessionId ??
    payload.session_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function normalizeEventName(raw) {
  return String(raw || "Unknown")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function normalizeSource(raw) {
  const source = String(raw || "unknown")
    .trim()
    .toLowerCase();
  if (
    source === "claude" ||
    source === "codex" ||
    source === "trae" ||
    source === "traecli" ||
    source === "traex"
  ) {
    return source;
  }
  return "unknown";
}

function normalizeReason(raw) {
  const reason = String(raw || "hook_stop")
    .trim()
    .toLowerCase();
  return COMPLETION_REASONS.has(reason) ? reason : "hook_stop";
}

function deriveCompletionEndpoint(endpoint) {
  if (!endpoint) {
    return undefined;
  }
  return endpoint.replace(
    /\/internal\/terminal\/agent-hook\/?$/,
    "/internal/terminal-completion",
  );
}

function deriveAgentHookEndpoint(endpoint) {
  if (!endpoint) {
    return undefined;
  }
  return endpoint.replace(
    /\/internal\/terminal-completion\/?$/,
    "/internal/terminal/agent-hook",
  );
}

function toAgentHookStateEvent(normalizedEvent) {
  if (
    normalizedEvent === "sessionstart" ||
    normalizedEvent === "session_start"
  ) {
    return "SessionStart";
  }
  if (
    normalizedEvent === "userpromptsubmit" ||
    normalizedEvent === "user_prompt_submit"
  ) {
    return "UserPromptSubmit";
  }
  if (STOP_EVENTS.has(normalizedEvent)) {
    return "Stop";
  }
  if (normalizedEvent === "pretooluse" || normalizedEvent === "pre_tool_use") {
    return "ToolRequested";
  }
  if (
    normalizedEvent === "posttooluse" ||
    normalizedEvent === "post_tool_use"
  ) {
    return "ToolCompleted";
  }
  return null;
}

function buildCompletionHookBody({
  terminalSessionId,
  payload,
  source,
  completionReason,
  rawEvent,
  commandName,
}) {
  return {
    terminalSessionId,
    source,
    completionReason,
    commandName: commandName || null,
    rawHookEvent: String(rawEvent || "Stop"),
    hookEvent: String(rawEvent || "Stop"),
    summary: extractCompletionSummary(payload),
    operationId: process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID || null,
    panelId: process.env.RUNWEAVE_TERMINAL_PANEL_ID || null,
    tmuxPaneId: process.env.TMUX_PANE || null,
    cwd:
      typeof payload.cwd === "string" && payload.cwd.trim()
        ? payload.cwd
        : process.env.PWD || null,
  };
}

function buildAppServerBaseEvent({
  kind,
  payload,
  rawEvent,
  normalizedEvent,
  stateHookEvent,
  source,
  terminalSessionId,
  threadId,
  commandName,
  dedupePrefix,
}) {
  const terminalPanelId = process.env.RUNWEAVE_TERMINAL_PANEL_ID || null;
  const tmuxPaneId = process.env.TMUX_PANE || null;
  return {
    kind,
    source: {
      app: "hook",
      instanceId: `${source}:${terminalSessionId}`,
      pid: process.pid,
    },
    scope: {
      projectId: process.env.RUNWEAVE_PROJECT_ID || null,
      terminalSessionId,
      terminalPanelId,
      terminalTmuxPaneId: tmuxPaneId,
      cwd:
        typeof payload.cwd === "string" && payload.cwd.trim()
          ? payload.cwd
          : process.env.PWD || null,
    },
    dedupeKey: `${dedupePrefix}:${source}:${terminalSessionId}:${String(
      rawEvent || "Unknown",
    )}:${threadId || "no-thread"}:${Date.now()}`,
    correlationId: threadId,
    payload: {
      source,
      threadId,
      rawHookEvent: String(rawEvent || "Unknown"),
      normalizedEvent,
      stateHookEvent,
      panelId: terminalPanelId,
      tmuxPaneId,
      commandName: commandName || null,
      operationId: process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID || null,
    },
  };
}

module.exports = {
  STOP_EVENTS,
  buildAppServerBaseEvent,
  buildCompletionHookBody,
  deriveAgentHookEndpoint,
  deriveCompletionEndpoint,
  extractCompletionSummary,
  extractToolHook,
  extractUserPrompt,
  normalizeEventName,
  normalizeReason,
  normalizeSource,
  parseTmuxSocketPath,
  parseArgs,
  parsePayload,
  readHookEvent,
  readTmuxPaneContext,
  readThreadId,
  toAgentHookStateEvent,
};
