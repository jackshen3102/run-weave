import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeJsonHookEntry,
  renderTraeHookBlock,
  buildLauncherScript,
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
