/* global module, process, require, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getCommandBasename } = require("./runweave-hook-tmux.cjs");
const { stripAgyPromptTags } = require("./runweave-hook-agy.cjs");

const STOP_EVENTS = new Set(["stop"]);
const COMPLETION_REASONS = new Set([
  "hook_stop",
  "notify",
  "ai_process_exit",
  "manual",
]);

function isNestedCodexProcess(spawnSync) {
  // A nested CLI inherits terminal/pane identity. Its hook still belongs to
  // the child CLI, even when tmux reports the parent as the foreground command.
  const result = spawnSync("ps", ["-ww", "-axo", "pid=,ppid=,args="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  // Reject only proven nesting; an unavailable process snapshot must not
  // disable normal hooks or shared-daemon hooks with a different ancestry.
  if (result.error || result.status !== 0) return false;
  const processes = new Map();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*?))?\s*$/);
    if (match) {
      processes.set(Number(match[1]), {
        parent: Number(match[2]),
        command: getCommandBasename(match[3]),
        // Shared app-server and its daemon supervisor both use the codex
        // executable. Neither is a parent CLI that owns this terminal.
        appServer: /^app-server(?:\s|$)/.test(match[4] || ""),
      });
    }
  }
  let codexCount = 0;
  const visited = new Set();
  for (let pid = process.ppid; pid > 1 && !visited.has(pid); ) {
    visited.add(pid);
    const entry = processes.get(pid);
    if (!entry) break;
    if (entry.command === "codex" && !entry.appServer && ++codexCount > 1) return true;
    pid = entry.parent;
  }
  return false;
}

function normalizeSummaryText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= 8000) return trimmed;
  const suffix = "\n...[truncated]";
  let end = 8000 - suffix.length;
  // Keep the marker inside the wire limit without splitting a UTF-16 pair.
  if (/[\uD800-\uDBFF]/.test(trimmed[end - 1])) end -= 1;
  return `${trimmed.slice(0, end)}${suffix}`;
}

function extractCompletionSummary(payload) {
  const directKeys = [
    "last_assistant_message",
    "lastAssistantMessage",
    "last_agent_message",
    "assistant_message",
    "assistantMessage",
  ];
  for (const key of directKeys) {
    const normalized = normalizeSummaryText(payload?.[key]);
    if (normalized) {
      return normalized;
    }
  }
  const fromTranscript = readTranscriptReply(payload);
  if (fromTranscript) return fromTranscript;
  for (const key of [
    "summary",
    "message",
    "last_message",
    "lastMessage",
    "response",
    "output",
    "text",
    "content",
    "body",
  ]) {
    const normalized = normalizeSummaryText(payload?.[key]);
    if (normalized) return normalized;
  }
  return null;
}

function readTranscriptReply(payload) {
  if (Array.isArray(payload?.transcript))
    return lastAssistantReply(payload.transcript);
  const sessionId = readThreadId(payload);
  const rawTranscriptPaths = [payload?.transcript_path, payload?.transcriptPath];
  const candidates = [];
  for (const rawPath of rawTranscriptPaths) {
    if (typeof rawPath === "string" && rawPath) {
      if (/[/\\]transcript\.jsonl$/.test(rawPath)) {
        candidates.push(rawPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl"));
      }
      candidates.push(rawPath);
    }
  }
  if (sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId)) {
    candidates.push(
      path.join(
        os.homedir(),
        "Library/Caches/coco/sessions",
        sessionId,
        "events.jsonl",
      ),
    );
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    let descriptor;
    try {
      descriptor = fs.openSync(candidate, "r");
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) continue;
      // Bound hook work even for very long conversations and tool output.
      const start = Math.max(0, stat.size - 1024 * 1024);
      const buffer = Buffer.alloc(stat.size - start);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, start);
      const tail = buffer.subarray(0, bytes).toString("utf8");
      const lines = (start ? tail.slice(tail.indexOf("\n") + 1) : tail).split(
        /\r?\n/,
      );
      const records = lines.flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      return lastAssistantReply(records);
    } catch {
      // A missing transcript must not prevent completion reporting.
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return null;
}

function lastAssistantReply(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.source === "USER_EXPLICIT" && record?.type === "USER_INPUT") {
      return null;
    }
    if (record?.source === "MODEL" && record?.type === "PLANNER_RESPONSE") {
      const normalized = normalizeSummaryText(record.content);
      if (normalized) return normalized;
      continue;
    }
    if (record?.type === "event_msg") {
      if (record.payload?.type === "task_complete") {
        const completed = normalizeSummaryText(
          record.payload.last_agent_message,
        );
        if (completed) return completed;
      }
      if (record.payload?.type === "task_started") return null;
    }
    const item =
      record?.type === "response_item"
        ? record.payload
        : (record?.message?.message ??
          (typeof record?.message === "object" ? record.message : record));
    const role = item?.role ?? item?.type;
    if (role === "user") return null;
    if (role !== "assistant" && role !== "agent") continue;
    if (item.phase && item.phase !== "final_answer") continue;
    const content = Array.isArray(item.content)
      ? item.content
          .filter((part) => part.type === "text" || part.type === "output_text")
          .map((part) => part.text ?? "")
          .join("\n")
      : (item.content ?? item.text ?? item.message);
    const normalized = normalizeSummaryText(content);
    if (normalized) return normalized;
  }
  return null;
}

function extractUserPrompt(payload) {
  for (const key of ["prompt", "query", "user_prompt", "userPrompt", "lastUserInput", "last_user_input", "message"]) {
    const raw = payload?.[key];
    const cleaned = typeof raw === "string" && (key === "lastUserInput" || key === "last_user_input")
      ? stripAgyPromptTags(raw)
      : raw;
    const normalized = normalizeSummaryText(cleaned);
    if (normalized) return normalized.slice(0, 8000);
  }
  return null;
}

function extractToolHook(payload) {
  const toolCall = payload?.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : null;
  const toolUseId =
    payload?.tool_use_id ?? payload?.toolUseId ?? payload?.tool_call_id ?? toolCall?.id;
  const toolName = payload?.tool_name ?? payload?.toolName ?? payload?.name ?? toolCall?.name;
  const toolResult = payload?.tool_response ?? payload?.tool_result ?? payload?.output;
  // Read provider metadata only. Text output (including JSON-looking text) is
  // untrusted tool content and cannot establish execution success or failure.
  const exitCode = payload?.exit_code ?? toolResult?.exit_code;
  const isError = payload?.is_error ?? toolResult?.is_error ?? (typeof payload?.error === "string" && payload.error.length > 0 ? true : undefined);
  const toolExecution = {
    ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(typeof isError === "boolean" ? { isError } : {}),
  };
  return {
    toolUseId:
      typeof toolUseId === "string" && toolUseId.trim()
        ? toolUseId.trim()
        : null,
    toolName:
      typeof toolName === "string" && toolName.trim() ? toolName.trim() : null,
    toolInput: payload?.tool_input ?? payload?.input ?? toolCall?.args,
    toolResult,
    ...(Object.keys(toolExecution).length ? { toolExecution } : {}),
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

function readNotificationType(payload) {
  const raw = payload.notification_type ?? payload.notificationType;
  return typeof raw === "string" && raw.trim()
    ? raw.trim().toLowerCase()
    : null;
}

function isFeishuAttentionHook(payload, source) {
  const event = normalizeEventName(readHookEvent(payload));
  return (event === "notification" && ["permission_prompt", "idle_prompt"].includes(readNotificationType(payload))) ||
    (toAgentHookStateEvent(event) === "ToolRequested" &&
      ["request_user_input", "functions.request_user_input", "AskUserQuestion", "ask_question"].includes(extractToolHook(payload).toolName)) ||
    (source === "pi" && payload.pi?.event === "ui_prompt_start");
}

function readThreadId(payload) {
  const raw =
    payload.threadId ??
    payload.thread_id ??
    payload.conversationId ??
    payload.conversation_id ??
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
    source === "pi" ||
    source === "traex" ||
    source === "agy"
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
  if (normalizedEvent === "agentmetadata") return "AgentMetadata";
  if (
    normalizedEvent === "sessionstart" ||
    normalizedEvent === "session_start"
  ) {
    return "SessionStart";
  }
  if (
    normalizedEvent === "userpromptsubmit" ||
    normalizedEvent === "user_prompt_submit" ||
    normalizedEvent === "preinvocation" ||
    normalizedEvent === "pre_invocation"
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
    ...(payload.feishuNotificationOnly ? { feishuNotificationOnly: true } : {}),
    ...(source === "pi" && payload.pi ? { pi: payload.pi } : {}),
    ...(source === "agy" && payload.agy ? { agy: payload.agy } : {}),
    completionReason,
    commandName: commandName || null,
    rawHookEvent: String(rawEvent || "Stop"),
    hookEvent: String(rawEvent || "Stop"),
    summary: extractCompletionSummary(payload),
    threadId: readThreadId(payload),
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
  const toolHook = extractToolHook(payload);
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
    dedupeKey: payload.pi ? `${dedupePrefix}:pi:${payload.pi.instanceId}:${payload.pi.sequence}` : `${dedupePrefix}:${source}:${terminalSessionId}:${String(
      rawEvent || "Unknown",
    )}:${threadId || "no-thread"}:${Date.now()}`,
    correlationId: threadId,
    payload: {
      source,
      ...(source === "pi" && payload.pi ? { pi: payload.pi } : {}),
    ...(source === "agy" && payload.agy ? { agy: payload.agy } : {}),
      ...(source === "claude" && payload.claude ? { claude: payload.claude } : {}),
      threadId,
      rawHookEvent: String(rawEvent || "Unknown"),
      normalizedEvent,
      stateHookEvent,
      activityEventId: payload.runweaveHookEventId,
      ...((stateHookEvent === "ToolRequested" || stateHookEvent === "ToolCompleted") && toolHook.toolName
        ? { toolName: toolHook.toolName }
        : {}),
      ...(stateHookEvent === "UserPromptSubmit" ? { query: extractUserPrompt(payload) } : {}),
      panelId: terminalPanelId,
      tmuxPaneId,
      commandName: commandName || null,
      operationId: process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID || null,
    },
  };
}

module.exports = {
  isNestedCodexProcess,
  isFeishuAttentionHook,
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
  parseArgs,
  parsePayload,
  readHookEvent,
  readNotificationType,
  readThreadId,
  toAgentHookStateEvent,
};

// The standalone Feishu script uses the same extractor as the completion hook.
if (require.main === module) {
  try {
    process.stdout.write(
      extractCompletionSummary(JSON.parse(fs.readFileSync(0, "utf8"))) ?? "",
    );
  } catch {
    process.exitCode = 0;
  }
}
