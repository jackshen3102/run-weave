// Installed CLI integration fixtures. Synthetic schema versions never enter a release.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { copyNativeLockRuntime } from "../../../packages/config-node/scripts/native-runtime.mjs";

export async function verifyConfigurationUpgrades({ repo, fixture, home, run, cliEntry, assert, env }) {
  const { build } = createRequire(path.join(repo, "packages/runweave-cli/package.json"))("esbuild");
  const dir = path.join(fixture, "configuration-cli");
  mkdirSync(dir);
  const steps = `[
    { id: "fixture-port-v2", from: 1, to: 2, migrate(document) {
      const port = document.getIn(["backend", "server", "legacyPort"]);
      if (port !== undefined) {
        document.setIn(["backend", "server", "port"], port);
        document.deleteIn(["backend", "server", "legacyPort"]);
      }
    } },
    { id: "fixture-retire-v3", from: 2, to: 3, migrate(document) { document.delete("legacyFlag"); } },
    { id: "fixture-logging-v2", domain: "logging", from: 1, to: 2, migrate(document) {
      const level = document.getIn(["logging", "oldLevel"]);
      if (level !== undefined) {
        document.setIn(["logging", "level"], level);
        document.deleteIn(["logging", "oldLevel"]);
      }
    } }
  ]`;
  for (const variant of ["complete", "gap"]) {
    await build({
      entryPoints: [path.join(repo, "packages/runweave-cli/src/index.ts")],
      outfile: path.join(dir, `${variant}.cjs`), bundle: true, platform: "node", format: "cjs",
      external: ["fs-native-extensions"], logLevel: "silent",
      plugins: [{ name: "isolated-configuration-versions", setup(builder) {
        builder.onLoad({ filter: /configuration\/compatibility\.ts$/ }, ({ path: file }) => ({
          contents: readFileSync(file, "utf8")
            .replace("CONFIGURATION_SCHEMA_VERSION: number = 1", "CONFIGURATION_SCHEMA_VERSION: number = 3")
            .replace("[domain, 1]", '[domain, domain === "logging" ? 2 : 1]'), loader: "ts",
        }));
        builder.onLoad({ filter: /config-node\/src\/version-migrations\.ts$/ }, ({ path: file }) => ({
          contents: readFileSync(file, "utf8").replace("ConfigurationVersionMigration[] = []", `ConfigurationVersionMigration[] = ${variant === "gap" ? steps + ".slice(1)" : steps}`), loader: "ts",
        }));
      } }],
    });
  }
  copyNativeLockRuntime(dir);
  const invoke = (variant, args) => run(process.execPath, [path.join(dir, `${variant}.cjs`), "config", ...args]);
  const reject = async (action, code) => {
    let rejected = false;
    try { await action(); } catch (error) { assert(error.message.includes(code), `Expected ${code}: ${error.message}`); rejected = true; }
    assert(rejected, `Expected rejection: ${code}`);
  };
  const makeCase = (id, overrides = {}) => {
    const root = path.join(home, ".runweave/dev-sessions", id);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "settings.yaml");
    const value = { schemaVersion: 1, revision: 7, kind: "dev", instanceId: id, domainVersions: { "backend.server": 1, logging: 1 }, migrations: {},
      backend: { server: { legacyPort: 5123 } }, logging: { oldLevel: "warn" }, legacyFlag: true, ...overrides };
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const args = ["--instance", id, "--config-dir", root, "--json"];
    const plan = () => invoke("complete", ["upgrade", "--dry-run", ...args]).then(JSON.parse);
    const apply = preview => invoke("complete", ["upgrade", "--expected-revision", String(preview.expectedRevision), "--expected-digest", preview.expectedDigest, ...args]).then(JSON.parse);
    return { root, file, value, args, plan, apply };
  };

  // A live real Backend/App Server must prevent offline schema mutation.
  const stableFile = path.join(home, ".runweave/settings.yaml");
  const stableBefore = readFileSync(stableFile, "utf8");
  const live = JSON.parse(await invoke("complete", ["upgrade", "--dry-run", "--instance", "stable", "--json"]));
  await reject(() => invoke("complete", ["upgrade", "--instance", "stable", "--expected-revision", String(live.expectedRevision), "--expected-digest", live.expectedDigest]), "CONFIG_UPGRADE_CONSUMER_RUNNING");
  assert(readFileSync(stableFile, "utf8") === stableBefore, "Running instance config changed");

  const c = makeCase("upgrade-chain");
  const original = readFileSync(c.file, "utf8");
  const preview = await c.plan();
  assert(preview.steps.length === 3 && preview.source.schemaVersion === 1 && preview.target.schemaVersion === 3, "Cross-version plan incomplete");
  assert(readFileSync(c.file, "utf8") === original, "Preview wrote settings");
  const committed = await c.apply(preview);
  const stored = JSON.parse(await invoke("complete", ["show", ...c.args])).values;
  assert(stored.schemaVersion === 3 && stored.revision === 8 && stored.backend.server.port === 5123 && !Object.hasOwn(stored.backend.server, "legacyPort") && !Object.hasOwn(stored, "legacyFlag"), "Migration did not produce only the target structure");
  assert(stored.domainVersions.logging === 2 && stored.logging.level === "warn" && !Object.hasOwn(stored.logging, "oldLevel"), "Domain migration did not preserve its value");
  assert(readFileSync(path.join(c.root, "config-backups", committed.backupId), "utf8") === original, "Migration backup differs from source");
  assert((statSync(c.file).mode & 0o077) === 0, "Migrated configuration is not private");
  const receipt = JSON.parse(readFileSync(path.join(c.root, "config-upgrade.json"), "utf8"));
  assert(receipt.phase === "committed" && receipt.digest === committed.digest, "Missing committed recovery receipt");
  const latestBytes = readFileSync(c.file, "utf8");
  const latest = await c.plan();
  const again = await c.apply(latest);
  assert(!again.changed && again.savedRevision === 8 && readFileSync(c.file, "utf8") === latestBytes, "Repeated upgrade rewrote configuration");

  const adjacent = makeCase("upgrade-adjacent", { schemaVersion: 2, backend: { server: { port: 5123 } }, logging: { level: "warn" }, domainVersions: { "backend.server": 1, logging: 2 } });
  const adjacentPlan = await adjacent.plan();
  assert(adjacentPlan.steps.length === 1, "Adjacent upgrade did not select the remaining step");
  await adjacent.apply(adjacentPlan);

  const conflict = makeCase("upgrade-conflict");
  const stale = await conflict.plan();
  writeFileSync(conflict.file, readFileSync(conflict.file, "utf8") + "\n# concurrent edit\n");
  const concurrentBytes = readFileSync(conflict.file, "utf8");
  await reject(() => conflict.apply(stale), "CONFIG_REVISION_CONFLICT");
  assert(readFileSync(conflict.file, "utf8") === concurrentBytes && !existsSync(path.join(conflict.root, "config-upgrade.json")), "Conflict overwrote the concurrent edit");

  for (const [id, overrides, variant, code] of [
    ["upgrade-future", { schemaVersion: 4 }, "complete", "CONFIG_UPGRADE_FUTURE_VERSION"],
    ["upgrade-gap", {}, "gap", "CONFIG_UPGRADE_PATH_MISSING"],
    ["upgrade-invalid", { backend: { server: { legacyPort: "invalid" } } }, "complete", "CONFIG_VALIDATION_FAILED"],
    ["upgrade-credentials", { backend: { auth: { username: "fixture" } } }, "complete", "CONFIG_VALIDATION_FAILED"],
  ]) {
    const item = makeCase(id, overrides);
    const before = readFileSync(item.file, "utf8");
    await reject(() => invoke(variant, ["upgrade", "--dry-run", ...item.args]), code);
    assert(readFileSync(item.file, "utf8") === before, `${id} changed settings`);
  }

  // The old executable restores its compatible backup while treating new fields as opaque.
  const recoverable = makeCase("upgrade-restore", { backend: { server: { port: 5123 } }, logging: { level: "warn" }, legacyFlag: undefined });
  const recoverableCommit = await recoverable.apply(await recoverable.plan());
  const restoreArgs = ["restore", recoverableCommit.backupId, ...recoverable.args];
  const restore = JSON.parse(await run(cliEntry, ["config", ...restoreArgs, "--dry-run"]));
  await run(cliEntry, ["config", ...restoreArgs, "--expected-revision", String(restore.expectedRevision), "--expected-digest", restore.expectedDigest, "--expected-backup-digest", restore.backupDigest]);
  const restored = JSON.parse(await run(cliEntry, ["config", "show", ...recoverable.args])).values;
  assert(restored.schemaVersion === 1 && restored.revision === 9 && restored.backend.server.port === 5123, "Matching executable did not restore old config with monotonic revision");

  for (const phase of ["before", "after"]) {
    const interrupted = makeCase(`upgrade-crash-${phase}`);
    const crashPlan = await interrupted.plan();
    const fault = path.join(fixture, `config-crash-${phase}.cjs`);
    writeFileSync(fault, `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=function(from,to){
      if(to===${JSON.stringify(realpathSync(interrupted.file))}){if(${JSON.stringify(phase)}==='before')process.kill(process.pid,'SIGKILL');
      rename(from,to);process.kill(process.pid,'SIGKILL');}return rename(from,to);};`);
    let crashed = false;
    try {
      await run(process.execPath, [path.join(dir, "complete.cjs"), "config", "upgrade", ...interrupted.args,
        "--expected-revision", String(crashPlan.expectedRevision), "--expected-digest", crashPlan.expectedDigest],
      { env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS} --require=${fault}` } });
    } catch { crashed = true; }
    assert(crashed, "Fault injection did not interrupt the CLI");
    const pending = JSON.parse(readFileSync(path.join(interrupted.root, "config-upgrade.json"), "utf8"));
    assert(pending.phase === "prepared" && existsSync(path.join(interrupted.root, "config-backups", pending.backupId)), "Interrupted migration lost its recovery point");
    const resumed = await interrupted.plan();
    assert(resumed.source.schemaVersion === (phase === "before" ? 1 : 3), "Interrupted write left a partial config");
    await interrupted.apply(resumed);
    const final = JSON.parse(readFileSync(path.join(interrupted.root, "config-upgrade.json"), "utf8"));
    assert(final.phase === "committed" && final.savedRevision === 8, "Recovery repeated or lost the migration commit");
  }
  return { crossVersion: true, adjacentVersion: true, noOp: true, conflict: true, liveOwner: true, invalidInputs: true, restore: true, interruptedCommit: true };
}
