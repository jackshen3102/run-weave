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
  hookEventName?: string;
  eventName?: string;
  sessionId?: string;
  toolName?: string;
  prompt?: string;
  lastAssistantMessage?: string;
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
  unknown: "Unknown",
};

const TERMINAL_BUNDLE_IDS: Record<string, string> = {
  ghostty: "com.mitchellh.ghostty",
  "apple_terminal": "com.apple.Terminal",
  iterm: "com.googlecode.iterm2",
  "iterm.app": "com.googlecode.iterm2",
  wezterm: "com.github.wez.wezterm",
};

export function normalizeHookEventName(raw: string): CanonicalHookEvent | string {
  const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
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
  const hookEventName = payload.hookEventName ?? payload.eventName ?? "Unknown";

  return {
    source,
    hookEvent: normalizeHookEventName(hookEventName),
    sessionId: payload.sessionId ?? "",
    cwd: env.PWD ?? null,
    terminalBundleId: detectTerminalBundleId(env),
    toolName: payload.toolName ?? null,
    prompt: payload.prompt ?? null,
    lastAssistantMessage: payload.lastAssistantMessage ?? null,
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
