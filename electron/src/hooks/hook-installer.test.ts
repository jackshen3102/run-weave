import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergeJsonHookEntry,
  renderTraeHookBlock,
  buildLauncherScript,
  upsertTraeHookBlock,
  installHooksIfNeeded,
  installClaudeHooks,
  installCodexHooks,
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

test("collapses duplicate browser-viewer entries for the same event down to one canonical entry", () => {
  const merged = mergeJsonHookEntry({
    existing: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: "browser-viewer-hook-bridge --source codex", timeout: 1 }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "/tmp/browser-viewer-hook-bridge --source codex", timeout: 2 }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "other-tool", timeout: 9 }],
      },
    ],
    command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 2);
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
    hooks: [{ type: "command", command: "other-tool", timeout: 9 }],
  });
});

test("keeps third-party hooks from later duplicate browser-viewer entries", () => {
  const merged = mergeJsonHookEntry({
    existing: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: "browser-viewer-hook-bridge --source codex", timeout: 1 }],
      },
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "/tmp/browser-viewer-hook-bridge --source codex", timeout: 2 },
          { type: "command", command: "third-party-tool", timeout: 9 },
        ],
      },
    ],
    command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 2);
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
    hooks: [{ type: "command", command: "third-party-tool", timeout: 9 }],
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

test("builds a self-contained launcher script that posts completion events", () => {
  const script = buildLauncherScript();

  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /RUNWEAVE_HOOK_ENDPOINT/);
  assert.match(script, /RUNWEAVE_HOOK_TOKEN/);
  assert.match(script, /RUNWEAVE_TERMINAL_SESSION_ID/);
  assert.match(script, /X-Runweave-Hook-Token/);
  assert.match(script, /fetch\(endpoint/);
  assert.doesNotMatch(script, /HOOK_BRIDGE_PATH/);
  assert.doesNotMatch(script, /hook-bridge\.mjs/);
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

test("upserts trae hooks only in the top-level hooks section and leaves nested profile hooks untouched", () => {
  const input = [
    "version: 1",
    "profiles:",
    "  default:",
    "    hooks:",
    "      - type: command",
    "        command: '/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source trae'",
    "        matchers:",
    "          - event: user_prompt_submit",
    "",
    "hooks:",
    "  - type: command",
    "    command: 'third-party-tool'",
    "    matchers:",
    "      - event: stop",
    "",
  ].join("\n");

  const output = upsertTraeHookBlock(
    input,
    renderTraeHookBlock("/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge"),
  );

  assert.equal((output.match(/^hooks:/gm) ?? []).length, 1);
  assert.ok(
    output.includes(
      "profiles:\n  default:\n    hooks:\n      - type: command\n        command: '/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source trae'",
    ),
  );
  assert.match(output, /third-party-tool/);
  assert.equal((output.match(/browser-viewer-hook-bridge --source trae/g) ?? []).length, 2);
});

test("replaces a browser-viewer trae list item even when its keys are reordered", () => {
  const input = [
    "version: 1",
    "hooks:",
    "  - command: 'third-party-tool'",
    "    type: command",
    "    matchers:",
    "      - event: stop",
    "  - command: '/tmp/browser-viewer-hook-bridge --source trae'",
    "    matchers:",
    "      - event: stop",
    "      - event: user_prompt_submit",
    "    type: command",
    "  - command: 'neighbor-tool'",
    "    type: command",
    "    matchers:",
    "      - event: post_tool_use",
    "",
  ].join("\n");

  const output = upsertTraeHookBlock(
    input,
    renderTraeHookBlock("/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge"),
  );

  assert.match(output, /third-party-tool/);
  assert.match(output, /neighbor-tool/);
  assert.equal((output.match(/browser-viewer-hook-bridge --source trae/g) ?? []).length, 1);
  assert.doesNotMatch(output, /\/tmp\/browser-viewer-hook-bridge --source trae/);
});

test("collapses multiple top-level trae browser-viewer blocks down to one block", () => {
  const input = [
    "version: 1",
    "hooks:",
    "  - type: command",
    "    command: 'third-party-tool'",
    "    matchers:",
    "      - event: stop",
    "  - type: command",
    "    command: '/tmp/browser-viewer-hook-bridge --source trae'",
    "    matchers:",
    "      - event: stop",
    "  - type: command",
    "    command: '/other/browser-viewer-hook-bridge --source trae'",
    "    matchers:",
    "      - event: user_prompt_submit",
    "  - type: command",
    "    command: 'neighbor-tool'",
    "    matchers:",
    "      - event: post_tool_use",
    "",
  ].join("\n");

  const output = upsertTraeHookBlock(
    input,
    renderTraeHookBlock("/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge"),
  );

  assert.match(output, /third-party-tool/);
  assert.match(output, /neighbor-tool/);
  assert.equal((output.match(/browser-viewer-hook-bridge --source trae/g) ?? []).length, 1);
  assert.doesNotMatch(output, /\/tmp\/browser-viewer-hook-bridge --source trae/);
  assert.doesNotMatch(output, /\/other\/browser-viewer-hook-bridge --source trae/);
});

test("expands an inline top-level hooks array instead of appending a second hooks key", () => {
  const input = ["version: 1", "hooks: []", "profiles:", "  default: true", ""].join("\n");

  const output = upsertTraeHookBlock(
    input,
    renderTraeHookBlock("/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge"),
  );

  assert.equal((output.match(/^hooks:/gm) ?? []).length, 1);
  assert.ok(output.includes("hooks:\n  - type: command"));
  assert.match(output, /browser-viewer-hook-bridge --source trae/);
  assert.match(output, /profiles:/);
});

test("preserves unknown array members when merging browser-viewer hooks", () => {
  const merged = mergeJsonHookEntry({
    existing: [
      {
        matcher: "*",
        hooks: [
          "unexpected-string",
          {
            type: "command",
            command: "browser-viewer-hook-bridge --source codex",
            timeout: 3,
          },
          7,
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
      "unexpected-string",
      {
        type: "command",
        command: "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
        timeout: 5,
      },
      7,
      {
        type: "command",
        command: "third-party-tool",
        timeout: 9,
      },
    ],
  });
});

test("leaves invalid existing JSON untouched in a temp home", async () => {
  const homeDir = await createTempHome();
  try {
    const claudeDir = path.join(homeDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    const invalid = "{ not-json";
    await writeFile(settingsPath, invalid, "utf8");

    await installClaudeHooks({ homeDir });

    assert.equal(await readFile(settingsPath, "utf8"), invalid);
    await assertRejectsMissing(path.join(claudeDir, "settings.json.browser-viewer-hook-backup"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("preserves an existing backup file when installing codex hooks in a temp home", async () => {
  const homeDir = await createTempHome();
  try {
    const codexDir = path.join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    const hooksPath = path.join(codexDir, "hooks.json");
    const backupPath = `${hooksPath}.browser-viewer-hook-backup`;
    await writeFile(
      hooksPath,
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "old" }] }] } }, null, 2),
      "utf8",
    );
    await writeFile(backupPath, "first-backup\n", "utf8");

    await installCodexHooks({ homeDir });

    assert.equal(await readFile(backupPath, "utf8"), "first-backup\n");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("skips launcher creation when no hook config directories exist in a temp home", async () => {
  const homeDir = await createTempHome();
  try {
    await installHooksIfNeeded({ homeDir });

    await assertRejectsMissing(path.join(homeDir, ".browser-viewer", "bin", "browser-viewer-hook-bridge"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

async function createTempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "browser-viewer-hooks-"));
}

async function assertRejectsMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}
