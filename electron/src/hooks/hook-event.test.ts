import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHookEventMessage,
  normalizeHookEventName,
} from "./hook-event.js";

test("normalizes claude/codex/trae event names to canonical values", () => {
  assert.equal(normalizeHookEventName("session_start"), "SessionStart");
  assert.equal(normalizeHookEventName("UserPromptSubmit"), "UserPromptSubmit");
  assert.equal(normalizeHookEventName("subagent_stop"), "Stop");
  assert.equal(normalizeHookEventName("SubagentStop"), "Stop");
  assert.equal(normalizeHookEventName({} as never), "Unknown");
});

test("builds a normalized message from a claude-style snake_case payload", () => {
  const message = buildHookEventMessage({
    source: "claude",
    stdinText: JSON.stringify({
      hook_event_name: "SubagentStop",
      event: "Stop",
      session_id: "sess-1",
      tool_name: "grep",
      prompt: "ship it",
      last_assistant_message: "previous assistant turn",
      cwd: "/tmp/from-payload",
    }),
    env: {
      PWD: "/tmp/from-env",
      TERM_PROGRAM: "ghostty",
    },
    now: new Date("2026-04-08T10:00:00.000Z"),
  });

  assert.equal(message.hookEvent, "Stop");
  assert.equal(message.sessionId, "sess-1");
  assert.equal(message.cwd, "/tmp/from-payload");
  assert.equal(message.terminalBundleId, "com.mitchellh.ghostty");
  assert.equal(message.toolName, "grep");
  assert.equal(message.prompt, "ship it");
  assert.equal(message.lastAssistantMessage, "previous assistant turn");
  assert.equal(message.timestamp, "2026-04-08T10:00:00.000Z");
});

test("falls back to a secondary event field when the primary field is blank", () => {
  const message = buildHookEventMessage({
    source: "claude",
    stdinText: JSON.stringify({
      hookEventName: "",
      event: "UserPromptSubmit",
      sessionId: "sess-blank",
    }),
    env: {
      PWD: "/tmp/from-env",
    },
    now: new Date("2026-04-08T10:00:00.000Z"),
  });

  assert.equal(message.hookEvent, "UserPromptSubmit");
  assert.equal(message.sessionId, "sess-blank");
  assert.equal(message.cwd, "/tmp/from-env");
});

test("handles malformed-but-valid json object shapes safely", () => {
  const message = buildHookEventMessage({
    source: "claude",
    stdinText: JSON.stringify({
      hook_event_name: {},
      event: {},
      session_id: "sess-2",
      tool_name: {},
      last_assistant_message: {},
      cwd: {},
    }),
    env: {
      PWD: "/tmp/fallback",
    },
    now: new Date("2026-04-08T10:00:00.000Z"),
  });

  assert.equal(message.hookEvent, "Unknown");
  assert.equal(message.sessionId, "sess-2");
  assert.equal(message.cwd, "/tmp/fallback");
  assert.equal(message.toolName, null);
  assert.equal(message.lastAssistantMessage, null);
});
