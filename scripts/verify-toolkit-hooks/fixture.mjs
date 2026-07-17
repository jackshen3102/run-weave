import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAllHooks } from "../../electron/src/hooks/hook-installer.ts";
import {
  findRunweaveHooks,
  verifyToolkitHookCommands,
} from "../verify-toolkit-hooks-helpers.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const resourcesDir = path.join(repoRoot, "electron", "resources");
const toolkitDir = path.join(repoRoot, "plugins", "toolkit");
const toolkitHooksDir = path.join(repoRoot, "plugins", "toolkit", "hooks");
const toolkitHooksConfigPath = path.join(toolkitDir, "hooks.json");
const electronHooksDir = path.join(resourcesDir, "hooks");
const hookAssets = [
  "app-server-client.cjs",
  "runweave-hook-bridge.cjs",
  "runweave-hook-dispatch.cjs",
  "runweave-hook-payload.cjs",
  "feishu_stop_notify.sh",
];
const toolkitHookEvents = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
];
const toolkitHookCommand =
  'sh -c \'for root in "${RUNWEAVE_TOOLKIT_PLUGIN_ROOT:-}" "__PLUGIN_DIR__" . "${CODEX_PLUGIN_ROOT:-}" "$HOME/.codex/plugins/cache/runweave/toolkit/latest" "$HOME/.codex/plugins/cache/runweave/toolkit"/* "${CLAUDE_PLUGIN_ROOT:-}"; do if [ -n "$root" ] && [ -f "$root/hooks/runweave-hook-dispatch.cjs" ]; then exec node "$root/hooks/runweave-hook-dispatch.cjs"; fi; done; exit 0\'';

const toolkitHooksConfig = JSON.parse(
  await readFile(toolkitHooksConfigPath, "utf8"),
);
verifyToolkitHookCommands(
  toolkitHooksConfig,
  toolkitHookEvents,
  toolkitHookCommand,
);

for (const asset of hookAssets) {
  const toolkitAsset = await readFile(
    path.join(toolkitHooksDir, asset),
    "utf8",
  );
  const electronAsset = await readFile(
    path.join(electronHooksDir, asset),
    "utf8",
  );
  assert.equal(
    electronAsset,
    toolkitAsset,
    `${asset} must stay synchronized between toolkit source and Electron resources`,
  );
}

export async function createToolkitHookFixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "runweave-hook-home-"));
  try {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await mkdir(path.join(homeDir, ".trae"), { recursive: true });
    const fakeTmuxPath = path.join(homeDir, "tmux");
    await writeFile(
      fakeTmuxPath,
      [
        "#!/bin/sh",
        'if [ "${RUNWEAVE_VERIFY_TMUX_FAIL:-0}" = "1" ]; then exit 1; fi',
        "printf '%s\\n' \"__RUNWEAVE_METADATA_FIELD____RUNWEAVE_METADATA_FIELD__${RUNWEAVE_VERIFY_PANE_COMMAND:-traex}__RUNWEAVE_METADATA_FIELD__node__RUNWEAVE_METADATA_FIELD__panel-pane-3\"",
        "",
      ].join("\n"),
    );
    await chmod(fakeTmuxPath, 0o755);
    const codexToolkitDir = path.join(
      homeDir,
      ".codex",
      "plugins",
      "cache",
      "runweave",
      "toolkit",
      "current",
    );
    const traeToolkitDir = path.join(
      homeDir,
      ".trae",
      ".tmp",
      "marketplaces",
      "local",
      "plugins",
      "toolkit",
    );
    await mkdir(path.join(codexToolkitDir, "hooks"), { recursive: true });
    for (const asset of hookAssets) {
      await copyFile(
        path.join(toolkitHooksDir, asset),
        path.join(codexToolkitDir, "hooks", asset),
      );
    }

    await writeFile(
      path.join(homeDir, ".codex", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: "/third-party/hook --keep",
                    timeout: 9,
                  },
                ],
              },
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: `${homeDir}/.browser-viewer/bin/browser-viewer-hook-bridge --source codex`,
                    timeout: 5,
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
            ],
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      path.join(homeDir, ".trae", "traecli.toml"),
      [
        'model = "test"',
        "",
        "# >>> runweave-hooks (managed by Runweave) >>>",
        "[[hooks.Stop]]",
        "",
        "[[hooks.Stop.hooks]]",
        "command = '/old/.runweave/bin/runweave-hook-bridge --source trae'",
        'timeout = "unlimited"',
        'type = "command"',
        "",
        "# <<< runweave-hooks (managed by Runweave) <<<",
        "",
        "# >>> runweave-hooks (managed by Browser Viewer) >>>",
        "[[hooks.Stop]]",
        "",
        "[[hooks.Stop.hooks]]",
        `command = '${homeDir}/.browser-viewer/bin/browser-viewer-hook-bridge --source trae'`,
        'timeout = "unlimited"',
        'type = "command"',
        "",
        "# <<< runweave-hooks (managed by Browser Viewer) <<<",
        "",
        "# >>> runweave-hooks (managed by Browser Viewer) >>>",
        "",
      ].join("\n"),
    );

    await installAllHooks({ homeDir, resourcesDir });

    const launcherPath = path.join(
      homeDir,
      ".runweave",
      "bin",
      "runweave-hook-bridge",
    );
    const installedLauncher = await readFile(launcherPath, "utf8");
    const resourceLauncher = await readFile(
      path.join(electronHooksDir, "runweave-hook-bridge.cjs"),
      "utf8",
    );
    assert.equal(installedLauncher, resourceLauncher);
    const installedAppServerClient = await readFile(
      path.join(homeDir, ".runweave", "bin", "app-server-client.cjs"),
      "utf8",
    );
    const resourceAppServerClient = await readFile(
      path.join(electronHooksDir, "app-server-client.cjs"),
      "utf8",
    );
    assert.equal(installedAppServerClient, resourceAppServerClient);
    const installedHookPayload = await readFile(
      path.join(homeDir, ".runweave", "bin", "runweave-hook-payload.cjs"),
      "utf8",
    );
    const resourceHookPayload = await readFile(
      path.join(electronHooksDir, "runweave-hook-payload.cjs"),
      "utf8",
    );
    assert.equal(installedHookPayload, resourceHookPayload);
    await chmod(launcherPath, 0o755);

    const codexHooks = JSON.parse(
      await readFile(path.join(homeDir, ".codex", "hooks.json"), "utf8"),
    );
    assert.equal(
      findRunweaveHooks(Object.values(codexHooks.hooks).flat()).length,
      0,
      "Codex global hooks must not contain Runweave hooks after plugin migration",
    );
    assert.deepEqual(codexHooks.hooks.Stop[0].hooks[0], {
      type: "command",
      command: "/third-party/hook --keep",
      timeout: 9,
    });
    assert.equal(
      JSON.stringify(codexHooks).includes("browser-viewer-hook-bridge"),
      false,
    );
    assert.equal(
      JSON.stringify(codexHooks).includes(".codex/notify.sh"),
      false,
    );

    const traeToml = await readFile(
      path.join(homeDir, ".trae", "traecli.toml"),
      "utf8",
    );
    assert.equal(traeToml.includes('model = "test"'), true);
    assert.equal(traeToml.includes("managed by Runweave"), false);
    assert.equal(traeToml.includes("managed by Browser Viewer"), false);
    assert.equal(traeToml.includes("browser-viewer-hook-bridge"), false);
    assert.equal(
      traeToml.includes("runweave-hook-bridge --source trae"),
      false,
    );
    assert.equal(
      traeToml.includes("/old/.runweave/bin/runweave-hook-bridge"),
      false,
    );
    for (const event of [
      "PostToolUse",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
    ]) {
      assert.equal(
        traeToml.includes(`[[hooks.${event}]]`),
        false,
        `Trae global TOML must not install ${event} after plugin migration`,
      );
    }

    return {
      codexToolkitDir,
      fakeTmuxPath,
      homeDir,
      launcherPath,
      toolkitDir,
      toolkitHooksConfig,
      traeToolkitDir,
      cleanup: () => rm(homeDir, { force: true, recursive: true }),
    };
  } catch (error) {
    await rm(homeDir, { force: true, recursive: true });
    throw error;
  }
}
