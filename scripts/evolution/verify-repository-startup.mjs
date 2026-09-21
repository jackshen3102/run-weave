// Real startup/SQLite integration, called with the closed v5 fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { prepareEvolutionRepositoryMigration } from "../../backend/src/bootstrap/evolution-migration.ts";
import { createRuntimeServices } from "../../backend/src/bootstrap/runtime-services.ts";
import { acquireBackendProfileLock } from "../../backend/src/server/profile-lock.ts";
import { auditRepositoryMigration } from "../../backend/src/evolution/storage/repository-migration-audit.ts";
import { privateJson } from "../../backend/src/evolution/storage/repository-migration-files.ts";

const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const Database = require("better-sqlite3");

function environment(data, env) {
  return {
    ...env,
    NODE_ENV: "development",
    ELECTRON_RUN_AS_NODE: "",
    RUNWEAVE_DESKTOP_CHANNEL: "dev",
    BROWSER_PROFILE_DIR: path.join(data, "profile"),
    RUNWEAVE_DEV_BROWSER_PROFILE_DIR: path.join(data, "profile"),
    AUTH_STORE_FILE: path.join(data, "auth.json"),
    TERMINAL_SESSION_STORE_FILE: path.join(data, "sessions.json"),
    RUNWEAVE_ACTIVITY_TEST_MODE: "true",
    RUNWEAVE_ACTIVITY_HOME: path.join(data, "activity"),
    RUNWEAVE_EVOLUTION_TEST_MODE: "true",
    RUNWEAVE_EVOLUTION_HOME: path.join(data, "evolution"),
    RUNWEAVE_APP_SERVER_DISCOVERY: "disabled",
    TERMINAL_TMUX_SOCKET_PATH: path.join(data, "tmux.sock"),
    TERMINAL_TMUX_SCAN_ORPHANS_ON_START: "false",
    TERMINAL_TMUX_CLEANUP_ORPHANS: "false",
  };
}

export async function verifyRepositoryStartup(root, data, env, passed) {
  const target = path.join(root, "auto-startup");
  await cp(data, target, { recursive: true });
  const isolated = environment(target, env);
  const file = path.join(target, "evolution/learning.sqlite");
  const busy = new Database(file);
  try {
    await assert.rejects(
      prepareEvolutionRepositoryMigration(isolated),
      /migration_database_busy/,
    );
    assert.equal(
      busy
        .prepare(
          "SELECT value FROM evolution_metadata WHERE key='schemaVersion'",
        )
        .get().value,
      "5",
    );
    busy
      .prepare(
        "UPDATE evolution_runs SET stage='queued',outcome=NULL WHERE run_id=(SELECT run_id FROM evolution_runs LIMIT 1)",
      )
      .run();
  } finally {
    busy.close();
  }
  const lock = await acquireBackendProfileLock({
    profileDir: path.join(target, "evolution/repository-startup"),
    port: null,
    host: undefined,
  });
  try {
    await assert.rejects(
      prepareEvolutionRepositoryMigration(isolated),
      /lock|already/i,
    );
  } finally {
    await lock.release();
  }
  passed(
    "startup-ownership",
    "Live database owners and concurrent startup owners prevent migration before any writer starts",
  );

  const originalEnv = { ...process.env };
  try {
    Object.assign(process.env, isolated);
    const runtime = await createRuntimeServices(
      "repository-startup-verification",
    );
    try {
      assert.ok(runtime.activityStore);
      assert.ok(runtime.evolutionAnalysisStore);
    } finally {
      await runtime.dispose();
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  const manifest = JSON.parse(
    await readFile(
      path.join(target, "evolution/repository-startup/manifest.json"),
      "utf8",
    ),
  );
  const migrated = new Database(file);
  try {
    const metadata = Object.fromEntries(
      migrated
        .prepare("SELECT key,value FROM evolution_metadata")
        .all()
        .map((row) => [row.key, row.value]),
    );
    assert.equal(metadata.schemaVersion, "6");
    assert.equal(metadata.repositoryMigrationState, "complete");
    assert.equal(metadata.repositorySchedulesResumed, manifest.migrationId);
    assert.ok(
      migrated
        .prepare("SELECT 1 FROM evolution_runs WHERE stage='blocked'")
        .get(),
    );
    assert.equal(
      migrated
        .prepare(
          "SELECT COUNT(*) AS n FROM evolution_schedules WHERE enabled=1",
        )
        .get().n,
      1,
    );
    // A later user decision must survive every subsequent startup.
    migrated.prepare("UPDATE evolution_schedules SET enabled=0").run();
  } finally {
    migrated.close();
  }
  assert.equal(
    (await prepareEvolutionRepositoryMigration(isolated)).status,
    "current",
  );
  const later = new Database(file);
  assert.equal(
    later
      .prepare("SELECT COUNT(*) AS n FROM evolution_schedules WHERE enabled=1")
      .get().n,
    0,
  );
  later.close();
  passed(
    "startup-automatic-migration",
    "Real Backend runtime factory automatically migrated v5 before starting SQLite workers, blocked unfinished legacy work, restored only a verified schedule; restart skipped migration and retained later user changes",
  );

  for (const checkpoint of ["activity", "complete"]) {
    const interruptedData = path.join(root, `auto-interrupted-${checkpoint}`);
    await cp(data, interruptedData, { recursive: true });
    const pending = await auditRepositoryMigration(interruptedData);
    const pendingFile = path.join(
      interruptedData,
      "evolution/repository-startup/manifest.json",
    );
    privateJson(pendingFile, pending);
    const child = path.join(root, `auto-interrupt-${checkpoint}.mts`);
    await writeFile(
      child,
      `
import { readFileSync } from 'node:fs';
import { acquireBackendProfileLock } from ${JSON.stringify(new URL("../../backend/src/server/profile-lock.ts", import.meta.url).href)};
import { applyRepositoryMigration } from ${JSON.stringify(new URL("../../backend/src/evolution/storage/repository-migration-apply.ts", import.meta.url).href)};
await acquireBackendProfileLock({profileDir:${JSON.stringify(path.dirname(pendingFile))},port:null,host:undefined});
await applyRepositoryMigration(JSON.parse(readFileSync(${JSON.stringify(pendingFile)},'utf8')),${JSON.stringify(interruptedData)},${checkpoint === "activity" ? "{afterActivityCommit(){process.exit(73)}}" : "undefined"});
process.exit(73);
`,
    );
    const result = spawnSync(
      process.execPath,
      [require.resolve("tsx/cli"), child],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 73, result.stderr);
    const recovered = await prepareEvolutionRepositoryMigration(
      environment(interruptedData, env),
    );
    assert.equal(recovered.migrationId, pending.migrationId);
    assert.equal(recovered.status, "migrated");
    assert.equal(
      (
        await prepareEvolutionRepositoryMigration(
          environment(interruptedData, env),
        )
      ).status,
      "current",
    );
  }
  passed(
    "startup-crash-recovery",
    "Actual child exits after Activity commit and after both DB commits recover automatically on startup with the same manifest and dead-owner locks",
  );
}
