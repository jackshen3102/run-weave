import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configurationLibrary as config } from "../../lib/configuration.mjs";
import { tsxImport, writeVerificationConfiguration } from "./configuration.mjs";

export async function configureLifecycle(changes) {
  const runtime = config.configuration();
  const snapshot = runtime.store.read();
  runtime.store.patch({
    expectedRevision: snapshot.value.revision,
    expectedDigest: snapshot.digest,
    changes,
  });
  const adopt = (owner) =>
    owner.markSnapshotApplied(
      owner.store.read(),
      "storage",
      "terminal",
      "logging",
      "appServer",
    );
  adopt(runtime);
  const esm = await import(
    new URL("../../../packages/config-node/src/index.ts", import.meta.url)
  );
  adopt(esm.configuration());
}

export async function isolateLifecycle(name) {
  const directory = path.join(config.configuration().context.configRoot, name);
  await configureLifecycle({
    "storage.browserProfileDirectory": directory,
    "storage.authStoreFile": path.join(directory, "auth.json"),
    "storage.terminalSessionStoreFile": path.join(directory, "sessions.json"),
    "storage.terminalQuickInputStoreFile": path.join(
      directory,
      "quick-inputs.json",
    ),
    "storage.scheduledTasksDirectory": path.join(directory, "scheduled-tasks"),
    "storage.activityDirectory": path.join(directory, "activity"),
    "storage.evolutionDirectory": path.join(directory, "evolution"),
    "storage.experienceDirectory": path.join(directory, "experience"),
    "storage.feishuDirectory": path.join(directory, "feishu"),
    "logging.backendDirectory": path.join(directory, "logs"),
    "logging.toFile": false,
    "appServer.discovery": "disabled",
    "terminal.tmux.shutdownPolicy": null,
    "terminal.tmux.scanOrphansOnStart": false,
    "terminal.tmux.cleanupOrphans": false,
  });
  Object.assign(process.env, {
    NODE_ENV: "development",
    ELECTRON_RUN_AS_NODE: "",
    RUNWEAVE_RUNTIME_RELEASE_ID: "",
    RUNWEAVE_ACTIVITY_TEST_MODE: "true",
    RUNWEAVE_EVOLUTION_TEST_MODE: "true",
    RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
    RUNWEAVE_EVOLUTION_WORKER_ENTRY: "",
  });
  return directory;
}

export async function runLifecycleCase(
  root,
  entry,
  name,
  channel = "dev",
  policy = "default",
) {
  const directory = await mkdtemp(path.join(root, "case-"));
  await writeVerificationConfiguration(
    directory,
    {},
    channel === "stable" ? "stable" : "dev",
  );
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsxImport,
      fileURLToPath(new URL("./bootstrap.mjs", import.meta.url)),
      directory,
      repoRoot,
      entry,
      "--case",
      name,
      channel,
      policy,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
        RUNWEAVE_EVOLUTION_WORKER_ENTRY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `${name}/${channel}/${policy}: ${output}`);
    const result = output
      .split("\n")
      .find((line) => line.startsWith('{"ok":true,"checks":'));
    assert(result, output);
    return JSON.parse(result).checks;
  } finally {
    clearTimeout(deadline);
  }
}
