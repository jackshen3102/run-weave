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
});

test("builds a normalized message from stdin json and environment", () => {
  const message = buildHookEventMessage({
    source: "codex",
    stdinText: JSON.stringify({
      hookEventName: "UserPromptSubmit",
      sessionId: "sess-1",
      prompt: "ship it",
    }),
    env: {
      PWD: "/tmp/project",
      TERM_PROGRAM: "ghostty",
    },
    now: new Date("2026-04-08T10:00:00.000Z"),
  });

  assert.equal(message.hookEvent, "UserPromptSubmit");
  assert.equal(message.sessionId, "sess-1");
  assert.equal(message.cwd, "/tmp/project");
  assert.equal(message.terminalBundleId, "com.mitchellh.ghostty");
});
