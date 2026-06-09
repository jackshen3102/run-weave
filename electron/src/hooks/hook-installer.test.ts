import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  access,
  rm,
  mkdir,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  mergeJsonHookEntry,
  pruneSupersededCodexHooks,
  pruneCodexConfigNotify,
  renderTraeTomlHookBlock,
  buildLauncherScript,
  stripLegacyCodexNotifyKey,
  upsertTraeTomlHookBlock,
  installHooksIfNeeded,
  installAllHooks,
  installClaudeHooks,
  installCodexHooks,
  installTraeHooks,
} from "./hook-installer.js";

const REPO_RESOURCES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
);

test("merges browser-viewer command into codex hook config without dropping existing hooks", () => {
  const merged = mergeJsonHookEntry({
    existing: [
      { matcher: "*", hooks: [{ type: "command", command: "other-tool" }] },
    ],
    command:
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
        command:
          "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
        hooks: [
          {
            type: "command",
            command: "browser-viewer-hook-bridge --source codex",
          },
        ],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "other-tool" }],
      },
    ],
    command:
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
        command:
          "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
        hooks: [
          {
            type: "command",
            command: "browser-viewer-hook-bridge --source codex",
            timeout: 1,
          },
        ],
      },
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "/tmp/browser-viewer-hook-bridge --source codex",
            timeout: 2,
          },
        ],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "other-tool", timeout: 9 }],
      },
    ],
    command:
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command:
          "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
        hooks: [
          {
            type: "command",
            command: "browser-viewer-hook-bridge --source codex",
            timeout: 1,
          },
        ],
      },
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "/tmp/browser-viewer-hook-bridge --source codex",
            timeout: 2,
          },
          { type: "command", command: "third-party-tool", timeout: 9 },
        ],
      },
    ],
    command:
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command:
          "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
    command:
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command:
          "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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

test("renders a stable trae TOML hook block covering the lifecycle events we care about", () => {
  const block = renderTraeTomlHookBlock(
    "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge",
  );

  assert.match(block, /\[\[hooks\.Stop\]\]/);
  assert.match(block, /\[\[hooks\.SubagentStop\]\]/);
  assert.match(block, /\[\[hooks\.PostToolUse\]\]/);
  assert.match(block, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(
    block,
    /command = '\/Users\/me\/\.browser-viewer\/bin\/browser-viewer-hook-bridge --source trae'/,
  );
  assert.match(block, /timeout = "unlimited"/);
  assert.match(block, /^# >>> runweave-hooks/m);
  assert.match(block, /^# <<< runweave-hooks/m);
});

test("builds a self-contained launcher script that posts state and completion hooks", () => {
  const script = buildLauncherScript();

  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /RUNWEAVE_HOOK_ENDPOINT/);
  assert.match(script, /RUNWEAVE_COMPLETION_HOOK_ENDPOINT/);
  assert.match(script, /RUNWEAVE_HOOK_TOKEN/);
  assert.match(script, /RUNWEAVE_TERMINAL_SESSION_ID/);
  assert.match(script, /X-Runweave-Hook-Token/);
  assert.match(script, /toAgentHookStateEvent/);
  assert.match(script, /SessionStart/);
  assert.match(script, /UserPromptSubmit/);
  assert.match(script, /Stop/);
  assert.match(script, /agent: "codex"/);
  assert.match(script, /fetch\(endpoint/);
  assert.match(script, /COMPLETION_REASONS/);
  assert.match(script, /completionReason/);
  assert.match(script, /notifyDesktop/);
  assert.match(script, /notifyFeishu/);
  assert.doesNotMatch(script, new RegExp("agent" + "-run-events"));
  assert.doesNotMatch(script, /HOOK_BRIDGE_PATH/);
  assert.doesNotMatch(script, /hook-bridge\.mjs/);
});

test("installs codex lifecycle hooks for terminal state", async () => {
  const homeDir = await createTempHome();
  try {
    const codexDir = path.join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });

    await installCodexHooks({ homeDir });

    const updated = JSON.parse(
      await readFile(path.join(codexDir, "hooks.json"), "utf8"),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const commands =
        updated.hooks[event]?.flatMap((entry) =>
          entry.hooks.map((hook) => hook.command),
        ) ?? [];
      assert.equal(
        commands.some((command) =>
          command.includes("browser-viewer-hook-bridge --source codex"),
        ),
        true,
      );
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("appends a runweave fenced block when traecli.toml has no existing block", () => {
  const input = [
    'model = "openrouter-2o"',
    "",
    "[profiles.yolo]",
    'approval_policy = "never"',
    "",
  ].join("\n");

  const output = upsertTraeTomlHookBlock(
    input,
    renderTraeTomlHookBlock(
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge",
    ),
  );

  assert.match(output, /^model = "openrouter-2o"/);
  assert.match(output, /\[profiles\.yolo\]/);
  assert.match(output, /\[\[hooks\.Stop\]\]/);
  assert.equal((output.match(/# >>> runweave-hooks/g) ?? []).length, 1);
  assert.equal((output.match(/# <<< runweave-hooks/g) ?? []).length, 1);
});

test("replaces the runweave fenced block in place without duplicating it", () => {
  const initial = upsertTraeTomlHookBlock(
    'model = "openrouter-2o"\n',
    renderTraeTomlHookBlock("/old/browser-viewer-hook-bridge"),
  );

  const output = upsertTraeTomlHookBlock(
    initial,
    renderTraeTomlHookBlock(
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge",
    ),
  );

  assert.equal((output.match(/# >>> runweave-hooks/g) ?? []).length, 1);
  assert.equal(
    (output.match(/browser-viewer-hook-bridge --source trae/g) ?? []).length,
    4,
  );
  assert.doesNotMatch(output, /\/old\/browser-viewer-hook-bridge/);
});

test("preserves unrelated trae TOML config (model, profiles, hooks.state) when upserting", () => {
  const input = [
    'model = "openrouter-2o"',
    "",
    "[profiles.yolo]",
    'sandbox_mode = "danger-full-access"',
    "",
    "[hooks.state]",
    "",
    '[hooks.state."/Users/me/.trae/traecli.toml:stop:0:0"]',
    'trusted_hash = "sha256:abc"',
    "",
    '[projects."/Users/me"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");

  const output = upsertTraeTomlHookBlock(
    input,
    renderTraeTomlHookBlock(
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge",
    ),
  );

  assert.match(output, /\[profiles\.yolo\]/);
  assert.match(output, /\[hooks\.state\]/);
  assert.match(output, /trusted_hash = "sha256:abc"/);
  assert.match(output, /\[projects\."\/Users\/me"\]/);
  assert.match(output, /\[\[hooks\.Stop\]\]/);
});

test("writes the runweave hook block into ~/.trae/traecli.toml on install", async () => {
  const homeDir = await createTempHome();
  try {
    const traeDir = path.join(homeDir, ".trae");
    await mkdir(traeDir, { recursive: true });
    const tomlPath = path.join(traeDir, "traecli.toml");
    await writeFile(tomlPath, 'model = "openrouter-2o"\n', "utf8");

    await installTraeHooks({ homeDir });

    const updated = await readFile(tomlPath, "utf8");
    assert.match(updated, /\[\[hooks\.Stop\]\]/);
    assert.match(updated, /\[\[hooks\.SubagentStop\]\]/);
    assert.match(
      updated,
      new RegExp(
        `command = '${homeDir.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\\\$&",
        )}/.browser-viewer/bin/browser-viewer-hook-bridge --source trae'`,
      ),
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("install is idempotent: re-running upsert does not duplicate the runweave block", async () => {
  const homeDir = await createTempHome();
  try {
    const traeDir = path.join(homeDir, ".trae");
    await mkdir(traeDir, { recursive: true });
    const tomlPath = path.join(traeDir, "traecli.toml");
    await writeFile(tomlPath, 'model = "openrouter-2o"\n', "utf8");

    await installTraeHooks({ homeDir });
    await installTraeHooks({ homeDir });

    const updated = await readFile(tomlPath, "utf8");
    assert.equal((updated.match(/# >>> runweave-hooks/g) ?? []).length, 1);
    assert.equal((updated.match(/# <<< runweave-hooks/g) ?? []).length, 1);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("strips pre-existing un-fenced runweave [[hooks.X]] entries when upserting", () => {
  const input = [
    'model = "openrouter-2o"',
    "",
    "[[hooks.PostToolUse]]",
    "",
    "[[hooks.PostToolUse.hooks]]",
    'command = "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source trae"',
    'timeout = "unlimited"',
    'type = "command"',
    "",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'command = "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source trae"',
    'timeout = "unlimited"',
    'type = "command"',
    "",
    "[hooks.state]",
    "",
    "",
  ].join("\n");

  const output = upsertTraeTomlHookBlock(
    input,
    renderTraeTomlHookBlock(
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge",
    ),
  );

  // Only the fenced block contributes Stop/PostToolUse entries — exactly one each.
  assert.equal((output.match(/\[\[hooks\.Stop\]\]/g) ?? []).length, 1);
  assert.equal((output.match(/\[\[hooks\.PostToolUse\]\]/g) ?? []).length, 1);
  assert.equal((output.match(/# >>> runweave-hooks/g) ?? []).length, 1);
  // Unrelated [hooks.state] section must remain.
  assert.match(output, /\[hooks\.state\]/);
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
    command:
      "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
    timeout: 5,
  });

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    matcher: "*",
    hooks: [
      "unexpected-string",
      {
        type: "command",
        command:
          "/Users/me/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
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
    await assertRejectsMissing(
      path.join(claudeDir, "settings.json.browser-viewer-hook-backup"),
    );
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
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { matcher: "*", hooks: [{ type: "command", command: "old" }] },
            ],
          },
        },
        null,
        2,
      ),
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

    await assertRejectsMissing(
      path.join(
        homeDir,
        ".browser-viewer",
        "bin",
        "browser-viewer-hook-bridge",
      ),
    );
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
        hooks: [
          {
            type: "command",
            command: `${home}/.codex/hooks/feishu_stop_notify.sh`,
            timeout: 10,
          },
        ],
      },
      {
        matcher: "*",
        hooks: [
          { type: "command", command: `${home}/.codex/notify.sh`, timeout: 5 },
        ],
      },
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `${home}/.browser-viewer/bin/browser-viewer-hook-bridge --source codex`,
            timeout: 5,
          },
        ],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "third-party-tool", timeout: 9 }],
      },
      // Third-party scripts that merely share the same file name must be kept.
      {
        matcher: "*",
        hooks: [
          { type: "command", command: `${home}/bin/notify.sh`, timeout: 3 },
        ],
      },
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "/opt/tool/feishu_stop_notify.sh",
            timeout: 3,
          },
        ],
      },
    ],
    home,
  );

  const commands = pruned.flatMap((entry) =>
    (entry as { hooks: Array<{ command: string }> }).hooks.map(
      (hook) => hook.command,
    ),
  );
  assert.equal(
    commands.includes(`${home}/.codex/hooks/feishu_stop_notify.sh`),
    false,
  );
  assert.equal(commands.includes(`${home}/.codex/notify.sh`), false);
  assert.equal(
    commands.includes(
      `${home}/.browser-viewer/bin/browser-viewer-hook-bridge --source codex`,
    ),
    true,
  );
  assert.equal(commands.includes("third-party-tool"), true);
  assert.equal(commands.includes(`${home}/bin/notify.sh`), true);
  assert.equal(commands.includes("/opt/tool/feishu_stop_notify.sh"), true);
});

test("copies the bundled Feishu notify script into the user home as executable", async () => {
  const homeDir = await createTempHome();
  try {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await installAllHooks({ homeDir, resourcesDir: REPO_RESOURCES_DIR });

    const scriptPath = path.join(
      homeDir,
      ".browser-viewer",
      "hooks",
      "feishu_stop_notify.sh",
    );
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
              {
                hooks: [
                  {
                    type: "command",
                    command: `${homeDir}/.codex/hooks/feishu_stop_notify.sh`,
                    timeout: 10,
                  },
                ],
              },
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: `${homeDir}/.codex/notify.sh`,
                    timeout: 5,
                  },
                ],
              },
              {
                matcher: "*",
                hooks: [
                  { type: "command", command: "third-party-tool", timeout: 9 },
                ],
              },
              // Third-party script with the same basename but a different path must survive.
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: `${homeDir}/bin/notify.sh`,
                    timeout: 3,
                  },
                ],
              },
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
    const commands = updated.hooks.Stop.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    assert.equal(
      commands.includes(`${homeDir}/.codex/hooks/feishu_stop_notify.sh`),
      false,
    );
    assert.equal(commands.includes(`${homeDir}/.codex/notify.sh`), false);
    assert.equal(commands.includes("third-party-tool"), true);
    assert.equal(commands.includes(`${homeDir}/bin/notify.sh`), true);
    assert.equal(
      commands.some((command) =>
        command.includes("browser-viewer-hook-bridge --source codex"),
      ),
      true,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("strips a legacy top-level notify key that points at notify.sh (single-line array)", () => {
  const input = [
    'model = "gpt-5.5"',
    'approval_policy = "never"',
    'notify = ["bash", "/Users/me/.codex/notify.sh"]',
    "",
    '[projects."/Users/me"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");

  const output = stripLegacyCodexNotifyKey(input);
  assert.doesNotMatch(output, /^notify\s*=/m);
  assert.match(output, /^model = "gpt-5\.5"/m);
  assert.match(output, /\[projects\."\/Users\/me"\]/);
});

test("strips a legacy top-level notify key spanning multiple lines (SkyComputerUseClient wrapper)", () => {
  const input = [
    'model = "gpt-5.5"',
    "",
    "notify = [",
    '  "/Users/me/.codex/computer-use/Sky.app/Contents/MacOS/SkyComputerUseClient",',
    '  "turn-ended",',
    '  "--previous-notify",',
    '  "[\\"bash\\",\\"/Users/me/.codex/notify.sh\\"]",',
    "]",
    "",
    '[projects."/Users/me"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");

  const output = stripLegacyCodexNotifyKey(input);
  assert.doesNotMatch(output, /^notify\s*=/m);
  assert.doesNotMatch(output, /SkyComputerUseClient/);
  assert.match(output, /^model = "gpt-5\.5"/m);
  assert.match(output, /\[projects\."\/Users\/me"\]/);
});

test("keeps a third-party notify key that does not reference notify.sh", () => {
  const input = [
    'model = "gpt-5.5"',
    'notify = ["/usr/local/bin/my-third-party-notifier"]',
    "",
  ].join("\n");

  assert.equal(stripLegacyCodexNotifyKey(input), input);
});

test("does not touch a notify key nested inside a section table", () => {
  const input = [
    'model = "gpt-5.5"',
    "",
    "[some.section]",
    'notify = ["/Users/me/.codex/notify.sh"]',
    "",
  ].join("\n");

  // Section-scoped notify is not the legacy top-level field; leave it alone.
  assert.equal(stripLegacyCodexNotifyKey(input), input);
});

test("is a no-op when config.toml has no notify key", () => {
  const input = 'model = "gpt-5.5"\n';
  assert.equal(stripLegacyCodexNotifyKey(input), input);
});

test("pruneCodexConfigNotify writes back when notify.sh-shaped notify exists", async () => {
  const homeDir = await createTempHome();
  try {
    const codexDir = path.join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    await writeFile(
      configPath,
      [
        'model = "gpt-5.5"',
        'notify = ["bash", "' +
          path.join(homeDir, ".codex", "notify.sh") +
          '"]',
        "",
        '[projects."/Users/me"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      "utf8",
    );

    await pruneCodexConfigNotify({ homeDir });

    const updated = await readFile(configPath, "utf8");
    assert.doesNotMatch(updated, /^notify\s*=/m);
    assert.match(updated, /^model = "gpt-5\.5"/m);
    assert.match(updated, /\[projects\."\/Users\/me"\]/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("pruneCodexConfigNotify is a no-op when config.toml is missing", async () => {
  const homeDir = await createTempHome();
  try {
    const codexDir = path.join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    await pruneCodexConfigNotify({ homeDir });
    await assertRejectsMissing(path.join(codexDir, "config.toml"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("installCodexHooks also prunes the legacy notify key from config.toml", async () => {
  const homeDir = await createTempHome();
  try {
    const codexDir = path.join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    await writeFile(
      configPath,
      [
        'model = "gpt-5.5"',
        "notify = [",
        '  "/Users/me/.codex/computer-use/Sky.app/Contents/MacOS/SkyComputerUseClient",',
        '  "turn-ended",',
        '  "--previous-notify",',
        '  "[\\"bash\\",\\"' +
          path.join(homeDir, ".codex", "notify.sh") +
          '\\"]",',
        "]",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(codexDir, "hooks.json"),
      '{"hooks":{}}\n',
      "utf8",
    );

    await installCodexHooks({ homeDir, resourcesDir: REPO_RESOURCES_DIR });

    const updated = await readFile(configPath, "utf8");
    assert.doesNotMatch(updated, /^notify\s*=/m);
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
