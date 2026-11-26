import type { NativeRecordLocation, SessionSearchKind, SessionSearchOrigin, SessionSearchProvider } from "@runweave/shared/session-search";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const string = (v: unknown) => typeof v === "string" ? v : "";

export interface NativeSessionState {
  threadId: string;
  cwd: string;
  title: string;
  origin: SessionSearchOrigin;
  leaf: string | null;
  branching: boolean;
  historyStart: number;
  unsupported: boolean;
}

export interface ParsedNativeRecord {
  id: string;
  nodeId: string | null;
  kind: SessionSearchKind;
  text: string;
  callId: string | null;
  toolName: string | null;
  occurredAt: string | null;
  location: NativeRecordLocation;
}

export interface NativeParseResult {
  records: ParsedNativeRecord[];
  node?: { id: string; parent: string | null };
  issue?: string;
}

export function emptyNativeState(): NativeSessionState {
  return { threadId: "", cwd: "", title: "", origin: "unknown", leaf: null, branching: false, historyStart: 0, unsupported: false };
}

/** Text projection deliberately excludes images, encrypted reasoning and thinking blocks. */
export function nativeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => {
    const p = object(part);
    if (["text", "input_text", "output_text"].includes(string(p.type))) return string(p.text);
    return "";
  }).filter(Boolean).join("\n");
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, (key, child: unknown) =>
    /^(image|image_url|image_data|encrypted_content|thinking|reasoning|signature)$/i.test(key) ? "[omitted]" : child);
}

function contextInput(text: string): boolean {
  return /^(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<skill>|<turn_aborted>|\[runweave-task-supervision:|\[?System (?:message|reminder)|<local-command-caveat>|<command-name>|<local-command-stdout>)/i.test(text.trimStart());
}

function observeInput(state: NativeSessionState, text: string) {
  if (/^The following is the Codex agent history/i.test(text.trimStart())) state.origin = "review";
  else if (text.includes("<scheduled_run_context>") || /^\[runweave-derived:/i.test(text.trimStart())) state.origin = "background";
  else if (state.origin === "unknown" && !contextInput(text)) state.origin = "interactive";
  if (!state.title && !contextInput(text) && text.trim()) state.title = text.trim().slice(0, 180);
}

function timestamp(value: unknown): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function setIdentity(state: NativeSessionState, id: string, cwd: string) {
  if (id && state.threadId && state.threadId !== id) throw new Error("native_thread_identity_changed");
  state.threadId ||= id;
  if (cwd && state.cwd && state.cwd !== cwd) throw new Error("native_working_directory_changed");
  state.cwd ||= cwd;
}

function projectMessage(item: Row, state: NativeSessionState, location: NativeRecordLocation,
  at: string | null, nodeId: string | null, suffix = ""): ParsedNativeRecord[] {
  const type = string(item.type), role = string(item.role);
  const id = (nodeId || string(item.id) || `${location.byteOffset}`) + suffix;
  const base = { id, nodeId, occurredAt: at, location, callId: null, toolName: null };
  if (["function_call", "custom_tool_call", "tool_use", "toolCall"].includes(type)) {
    const input = item.arguments ?? item.input ?? item.argumentsJson ?? "";
    return [{ ...base, kind: "request", callId: string(item.call_id ?? item.id) || null,
      toolName: string(item.name) || null, text: nativeText(input) }];
  }
  if (["function_call_output", "custom_tool_call_output", "tool_result"].includes(type)) {
    return [{ ...base, kind: "result", callId: string(item.call_id ?? item.tool_use_id) || null,
      text: nativeText(item.output ?? item.content) }];
  }
  if (type !== "message" || !["user", "assistant"].includes(role)) return [];
  const channel = string(item.channel ?? item.phase);
  if (channel && !["commentary", "final", "final_answer"].includes(channel)) return [];
  const text = nativeText(item.content);
  if (!text.trim()) return [];
  if (role === "user") observeInput(state, text);
  return [{ ...base, text, kind: role === "user" && contextInput(text) ? "context" : role as "user" | "assistant" }];
}

function codexRow(row: Row, state: NativeSessionState, location: NativeRecordLocation): NativeParseResult {
  const p = object(row.payload), at = timestamp(row.timestamp);
  if (row.type === "session_meta") {
    setIdentity(state, string(p.id ?? p.session_id), string(p.cwd));
    state.historyStart = typeof p.subagent_history_start_ordinal === "number" ? p.subagent_history_start_ordinal : 0;
    if (p.source && typeof p.source === "object" || p.parent_thread_id) state.origin = "subagent";
    else if (p.source === "exec") state.origin = "background";
    return { records: [] };
  }
  if (typeof row.ordinal === "number" && row.ordinal < state.historyStart) return { records: [] };
  if (row.type === "response_item") return { records: projectMessage(p, state, location, at, null) };
  // Native FileChange receipts survive code-mode wrappers even when no inner request is exposed.
  if (row.type === "event_msg" && p.type === "item_completed") {
    const item = object(p.item);
    if (item.type === "CommandExecution") {
      const callId = string(item.id) || null;
      const base = { nodeId: null, callId, toolName: "native_command", occurredAt: at, location };
      const id = callId || String(location.byteOffset);
      return { records: [
        { ...base, id: id + ":request", kind: "request", text: nativeText({ command: item.command, cwd: item.cwd }) },
        { ...base, id: id + ":result", kind: "result", text: nativeText({ status: item.status, exit_code: item.exit_code, output: item.aggregated_output }) },
      ] };
    }
    if (item.type === "FileChange") return { records: [{ id: string(item.id) || String(location.byteOffset), nodeId: null,
      kind: "file_change", text: nativeText({ status: item.status, changes: item.changes, stdout: item.stdout, stderr: item.stderr }),
      callId: null, toolName: "native_file_change", occurredAt: at, location }] };
  }
  // A mutation stream requires canonical replay, not blind concatenation with response_item.
  // Refuse the source explicitly until that format has a verified adapter.
  if (row.type === "history_mutation") {
    state.unsupported = true;
    return { records: [], issue: "codex_history_mutation_unsupported" };
  }
  return { records: [] };
}

function piRow(row: Row, state: NativeSessionState, location: NativeRecordLocation): NativeParseResult {
  if (row.type === "session") {
    setIdentity(state, string(row.id), string(row.cwd));
    if (row.parentSession) state.origin = "subagent";
    return { records: [] };
  }
  const id = string(row.id), parent = typeof row.parentId === "string" ? row.parentId : null;
  if (!id) return { records: [] };
  state.branching = true;
  state.leaf = id;
  const result: NativeParseResult = { records: [], node: { id, parent } };
  if (row.type !== "message") return result;
  const message = object(row.message), at = timestamp(row.timestamp ?? message.timestamp);
  if (message.role === "toolResult") {
    result.records.push({ id, nodeId: id, kind: "result", text: nativeText(message.content),
      callId: string(message.toolCallId) || null, toolName: string(message.toolName) || null, occurredAt: at, location });
  } else {
    for (const [i, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
      result.records.push(...projectMessage(object(part), state, location, at, id, `:part:${i}`));
    }
    result.records.push(...projectMessage({ ...message, type: "message", id }, state, location, at, id));
  }
  return result;
}

function claudeRow(row: Row, state: NativeSessionState, location: NativeRecordLocation): NativeParseResult {
  if (row.type === "progress") return { records: [] };
  // Nested progress/sidechain records must never become the parent transcript.
  if ((row.isSidechain === true || row.agentId) && !location.path.includes("subagents")) return { records: [] };
  const session = string(row.sessionId);
  if (session) setIdentity(state, session, string(row.cwd));
  if (row.isSidechain === true || row.agentId) state.origin = "subagent";
  if (row.type === "last-prompt") {
    state.leaf = string(row.leafUuid) || state.leaf;
    return { records: [] };
  }
  if (!["user", "assistant", "system", "attachment"].includes(string(row.type))) return { records: [] };
  const id = string(row.uuid);
  if (!id) return { records: [], ...(row.type === "system" ? {} : { issue: "claude_node_identity_missing" }) };
  const compact = row.type === "system" && row.subtype === "compact_boundary";
  const parent = string(compact ? row.logicalParentUuid ?? row.parentUuid : row.parentUuid) || null;
  state.branching = true;
  state.leaf = id;
  const result: NativeParseResult = { records: [], node: { id, parent } };
  if (compact) result.issue = "claude_compaction_boundary";
  if (row.isMeta === true || row.isCompactSummary === true || row.repeatsCompactSummary === true || row.isVisibleInTranscriptOnly === true) return result;
  const message = object(row.message), at = timestamp(row.timestamp);
  for (const [i, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
    result.records.push(...projectMessage(object(part), state, location, at, id, `:part:${i}`));
  }
  result.records.push(...projectMessage({ ...message, type: "message", id }, state, location, at, id));
  return result;
}

function stripAgyPromptTags(text: string): string {
  const userRequestMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
  const base = userRequestMatch ? userRequestMatch[1]! : text;
  return base
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

function agyRow(row: Row, state: NativeSessionState, location: NativeRecordLocation): NativeParseResult {
  if (!state.threadId) {
    const match = /[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.exec(location.path);
    if (match?.[1]) state.threadId = match[1];
  }
  const source = string(row.source), type = string(row.type), at = timestamp(row.timestamp);
  const baseId = string(row.id) || String(location.byteOffset);
  if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
    const text = stripAgyPromptTags(string(row.content));
    if (!text) return { records: [] };
    observeInput(state, text);
    return {
      records: [{
        id: baseId, nodeId: null, kind: "user", text,
        callId: null, toolName: null, occurredAt: at, location,
      }],
    };
  }
  if (source === "MODEL" && type === "PLANNER_RESPONSE") {
    const records: ParsedNativeRecord[] = [];
    const text = string(row.content).trim();
    if (text) {
      records.push({
        id: baseId, nodeId: null, kind: "assistant", text,
        callId: null, toolName: null, occurredAt: at, location,
      });
    }
    if (Array.isArray(row.tool_calls)) {
      for (const [i, rawCall] of row.tool_calls.entries()) {
        const call = object(rawCall);
        const toolName = string(call.name) || null;
        const callId = string(call.id) || null;
        records.push({
          id: `${baseId}:tool:${i}`, nodeId: null, kind: "request",
          text: nativeText(call.args ?? call.arguments ?? call.input ?? ""),
          callId, toolName, occurredAt: at, location,
        });
      }
    }
    return { records };
  }
  if (source === "MODEL" && type === "GENERIC") {
    const text = nativeText(row.content).trim();
    if (!text) return { records: [] };
    return {
      records: [{
        id: baseId, nodeId: null, kind: "result", text,
        callId: string(row.call_id) || null, toolName: string(row.name) || null,
        occurredAt: at, location,
      }],
    };
  }
  return { records: [] };
}

export function parseNativeRow(provider: SessionSearchProvider, row: Row, state: NativeSessionState, location: NativeRecordLocation): NativeParseResult {
  if (provider === "codex") return codexRow(row, state, location);
  if (provider === "pi") return piRow(row, state, location);
  if (provider === "agy") return agyRow(row, state, location);
  return claudeRow(row, state, location);
}
