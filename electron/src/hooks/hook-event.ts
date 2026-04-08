export type CanonicalHookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "Unknown";

export interface HookEventMessage {
  source: "claude" | "codex" | "trae" | "unknown";
  hookEvent: CanonicalHookEvent | string;
  sessionId: string;
  cwd: string | null;
  terminalBundleId: string | null;
  toolName: string | null;
  prompt: string | null;
  lastAssistantMessage: string | null;
  timestamp: string;
}

interface BuildHookEventMessageInput {
  source: HookEventMessage["source"];
  stdinText: string;
  env: NodeJS.ProcessEnv;
  now: Date;
}

type HookEventPayload = {
  hookEventName?: unknown;
  hook_event_name?: unknown;
  eventName?: unknown;
  event?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  prompt?: unknown;
  lastAssistantMessage?: unknown;
  last_assistant_message?: unknown;
  cwd?: unknown;
};

const CANONICAL_EVENT_NAMES: Record<string, CanonicalHookEvent> = {
  sessionstart: "SessionStart",
  session_start: "SessionStart",
  sessionend: "SessionEnd",
  session_end: "SessionEnd",
  userpromptsubmit: "UserPromptSubmit",
  user_prompt_submit: "UserPromptSubmit",
  pretooluse: "PreToolUse",
  pre_tool_use: "PreToolUse",
  posttooluse: "PostToolUse",
  post_tool_use: "PostToolUse",
  permissionrequest: "PermissionRequest",
  permission_request: "PermissionRequest",
  notification: "Notification",
  stop: "Stop",
  subagent_stop: "Stop",
  subagentstop: "Stop",
  unknown: "Unknown",
};

const TERMINAL_BUNDLE_IDS: Record<string, string> = {
  ghostty: "com.mitchellh.ghostty",
  "apple_terminal": "com.apple.Terminal",
  iterm: "com.googlecode.iterm2",
  "iterm.app": "com.googlecode.iterm2",
  wezterm: "com.github.wez.wezterm",
};

export function normalizeHookEventName(raw: unknown): CanonicalHookEvent | string {
  if (typeof raw !== "string") {
    return "Unknown";
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return "Unknown";
  }

  const normalized = trimmed.toLowerCase().replace(/[-\s]+/g, "_");
  return CANONICAL_EVENT_NAMES[normalized] ?? raw;
}

export function detectTerminalBundleId(env: NodeJS.ProcessEnv): string | null {
  const termProgram = env.TERM_PROGRAM?.trim().toLowerCase();
  if (!termProgram) {
    return null;
  }

  return TERMINAL_BUNDLE_IDS[termProgram] ?? null;
}

export function buildHookEventMessage({
  source,
  stdinText,
  env,
  now,
}: BuildHookEventMessageInput): HookEventMessage {
  const payload = parseHookEventPayload(stdinText);
  const hookEventName = firstNonBlankString(
    payload.hookEventName,
    payload.hook_event_name,
    payload.eventName,
    payload.event,
  );

  return {
    source,
    hookEvent: normalizeHookEventName(hookEventName ?? "Unknown"),
    sessionId: firstNonBlankString(payload.sessionId, payload.session_id) ?? "",
    cwd: firstNonBlankString(payload.cwd, env.PWD),
    terminalBundleId: detectTerminalBundleId(env),
    toolName: firstNonBlankString(payload.toolName, payload.tool_name),
    prompt: firstNonBlankString(payload.prompt),
    lastAssistantMessage: firstNonBlankString(
      payload.lastAssistantMessage,
      payload.last_assistant_message,
    ),
    timestamp: now.toISOString(),
  };
}

function parseHookEventPayload(stdinText: string): HookEventPayload {
  if (!stdinText.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(stdinText) as HookEventPayload;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function firstNonBlankString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}
