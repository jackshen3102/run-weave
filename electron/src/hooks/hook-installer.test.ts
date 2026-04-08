import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeJsonHookEntry,
  renderTraeHookBlock,
  buildLauncherScript,
  upsertTraeHookBlock,
} from "./hook-installer.js";

test("merges browser-viewer command into codex hook config without dropping existing hooks", () => {
  const merged = mergeJsonHookEntry({
    existing: [{ matcher: "*", hooks: [{ type: "command", command: "other-tool" }] }],
    command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [{ type: "command", command: "other-tool" }],
  });
  assert.deepEqual(merged[1], {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
        timeout: 5,
      },
    ],
  });
});

test("replaces an existing browser-viewer entry instead of duplicating it", () => {
  const merged = mergeJsonHookEntry({
    existing: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: "browser-viewer-hook-bridge --source codex" }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "other-tool" }],
      },
    ],
    command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 2);
  assert.equal(
    merged.filter((entry) =>
      JSON.stringify(entry).includes("browser-viewer-hook-bridge"),
    ).length,
    1,
  );
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
        timeout: 5,
      },
    ],
  });
  assert.deepEqual(merged[1], {
    matcher: "*",
    hooks: [{ type: "command", command: "other-tool" }],
  });
});

test("preserves third-party hooks when a matcher entry contains browser-viewer and external commands", () => {
  const merged = mergeJsonHookEntry({
    existing: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "browser-viewer-hook-bridge --source codex",
            timeout: 3,
          },
          {
            type: "command",
            command: "third-party-tool",
            timeout: 9,
          },
        ],
      },
    ],
    command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
        timeout: 5,
      },
      {
        type: "command",
        command: "third-party-tool",
        timeout: 9,
      },
    ],
  });
});

test("renders a stable trae hook block", () => {
  const block = renderTraeHookBlock("/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge");

  assert.match(block, /user_prompt_submit/);
  assert.match(block, /subagent_stop/);
  assert.match(block, /browser-viewer-hook-bridge --source trae/);
});

test("builds launcher script pointing at packaged hook bridge", () => {
  const script = buildLauncherScript({
    packagedBridgePath: "/Applications/Browser Viewer.app/Contents/Resources/hook-bridge.mjs",
  });

  assert.match(script, /browser-viewer-hook-bridge/);
  assert.match(script, /hook-bridge\.mjs/);
  assert.match(script, /exec node/);
});

test("upserts trae hook into an existing top-level hooks section without duplicating it", () => {
  const input = [
    "version: 1",
    "hooks:",
    "  - type: command",
    "    command: 'other-tool'",
    "    matchers:",
    "      - event: user_prompt_submit",
    "",
    "profiles:",
    "  default: true",
    "",
  ].join("\n");

  const output = upsertTraeHookBlock(
    input,
    renderTraeHookBlock("/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge"),
  );

  assert.equal((output.match(/^hooks:/gm) ?? []).length, 1);
  assert.match(output, /other-tool/);
  assert.match(output, /browser-viewer-hook-bridge --source trae/);
  assert.match(output, /profiles:/);
});
