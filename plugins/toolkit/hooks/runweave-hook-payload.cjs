/* global module, process */

const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);
const COMPLETION_REASONS = new Set([
  "hook_stop",
  "notify",
  "ai_process_exit",
  "manual",
]);

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
    panelId: process.env.RUNWEAVE_TERMINAL_PANEL_ID || null,
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
  dedupePrefix,
}) {
  const terminalPanelId = process.env.RUNWEAVE_TERMINAL_PANEL_ID || null;
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
      rawHookEvent: String(rawEvent || "Unknown"),
      normalizedEvent,
      stateHookEvent,
    },
  };
}

module.exports = {
  STOP_EVENTS,
  buildAppServerBaseEvent,
  buildCompletionHookBody,
  deriveAgentHookEndpoint,
  deriveCompletionEndpoint,
  normalizeEventName,
  normalizeReason,
  normalizeSource,
  parseArgs,
  parsePayload,
  readHookEvent,
  readThreadId,
  toAgentHookStateEvent,
};
