import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access, rm, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  mergeJsonHookEntry,
  pruneSupersededCodexHooks,
  renderTraeHookBlock,
  buildLauncherScript,
  upsertTraeHookBlock,
  installHooksIfNeeded,
  installAllHooks,
  installClaudeHooks,
  installCodexHooks,
} from "./hook-installer.js";

const REPO_RESOURCES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
);

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
        _runweaveManaged: true,
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
        _runweaveManaged: true,
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
        _runweaveManaged: true,
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
        _runweaveManaged: true,
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
        _runweaveManaged: true,
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
  assert.match(script, /COMPLETION_REASONS/);
  assert.match(script, /completionReason === "hook_stop"/);
  assert.match(script, /notifyDesktop/);
  assert.match(script, /osascript/);
  assert.match(script, /afplay/);
  assert.match(script, /notifyFeishu/);
  assert.match(script, /\.browser-viewer\/hooks\/feishu_stop_notify\.sh/);
  assert.match(script, /fetch\(endpoint/);
  assert.doesNotMatch(script, /HOOK_BRIDGE_PATH/);
  assert.doesNotMatch(script, /hook-bridge\.mjs/);
  // Notifications are unified across sources; Feishu no longer points at ~/.codex.
  assert.doesNotMatch(script, /\.codex\/hooks\/feishu_stop_notify\.sh/);
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
        _runweaveManaged: true,
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

test("prunes only legacy codex notify entries at known paths, keeping launcher and third-party hooks", () => {
  const home = "/Users/me";
  const pruned = pruneSupersededCodexHooks(
    [
      {
        matcher: "*",
        hooks: [{ type: "command", command: `${home}/.codex/hooks/feishu_stop_notify.sh`, timeout: 10 }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: `${home}/.codex/notify.sh`, timeout: 5 }],
      },
      {
        matcher: "*",
        hooks: [
          { type: "command", command: `${home}/.browser-viewer/bin/browser-viewer-hook-bridge --source codex`, timeout: 5 },
        ],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "third-party-tool", timeout: 9 }],
      },
      // Third-party scripts that merely share the same file name must be kept.
      {
        matcher: "*",
        hooks: [{ type: "command", command: `${home}/bin/notify.sh`, timeout: 3 }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "/opt/tool/feishu_stop_notify.sh", timeout: 3 }],
      },
    ],
    home,
  );

  const commands = pruned.flatMap((entry) =>
    (entry as { hooks: Array<{ command: string }> }).hooks.map((hook) => hook.command),
  );
  assert.equal(commands.includes(`${home}/.codex/hooks/feishu_stop_notify.sh`), false);
  assert.equal(commands.includes(`${home}/.codex/notify.sh`), false);
  assert.equal(commands.includes(`${home}/.browser-viewer/bin/browser-viewer-hook-bridge --source codex`), true);
  assert.equal(commands.includes("third-party-tool"), true);
  assert.equal(commands.includes(`${home}/bin/notify.sh`), true);
  assert.equal(commands.includes("/opt/tool/feishu_stop_notify.sh"), true);
});

test("copies the bundled Feishu notify script into the user home as executable", async () => {
  const homeDir = await createTempHome();
  try {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await installAllHooks({ homeDir, resourcesDir: REPO_RESOURCES_DIR });

    const scriptPath = path.join(homeDir, ".browser-viewer", "hooks", "feishu_stop_notify.sh");
    const stats = await stat(scriptPath);
    assert.equal(stats.isFile(), true);
    assert.equal((stats.mode & 0o111) !== 0, true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("removes superseded codex notify hooks from hooks.json on install", async () => {
  const homeDir = await createTempHome();
  try {
    const codexDir = path.join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    const hooksPath = path.join(codexDir, "hooks.json");
    await writeFile(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: "command", command: `${homeDir}/.codex/hooks/feishu_stop_notify.sh`, timeout: 10 }] },
              { matcher: "*", hooks: [{ type: "command", command: `${homeDir}/.codex/notify.sh`, timeout: 5 }] },
              { matcher: "*", hooks: [{ type: "command", command: "third-party-tool", timeout: 9 }] },
              // Third-party script with the same basename but a different path must survive.
              { matcher: "*", hooks: [{ type: "command", command: `${homeDir}/bin/notify.sh`, timeout: 3 }] },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await installCodexHooks({ homeDir, resourcesDir: REPO_RESOURCES_DIR });

    const updated = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = updated.hooks.Stop.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.equal(commands.includes(`${homeDir}/.codex/hooks/feishu_stop_notify.sh`), false);
    assert.equal(commands.includes(`${homeDir}/.codex/notify.sh`), false);
    assert.equal(commands.includes("third-party-tool"), true);
    assert.equal(commands.includes(`${homeDir}/bin/notify.sh`), true);
    assert.equal(
      commands.some((command) => command.includes("browser-viewer-hook-bridge --source codex")),
      true,
    );
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
