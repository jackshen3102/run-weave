import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { stopSessionServices } from "../services/index.mjs";
import {
  readOwnedProcessGroup,
  stopOwnedProcess,
  stopSpawnedProcess,
} from "../services/process-stop.mjs";
import {
  isProcessLive,
  processIdentityMatches,
  readProcessSignature,
  spawnDetached,
} from "../services/runtime.mjs";
import { readManifest, writeManifest } from "../registry.mjs";
import { createManifest } from "./registry.mjs";

const execFileAsync = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Real child-process integration, including the repository-pinned pnpm/tsx
// forwarding chain. No product Backend or installed runtime is launched here.
const fixtureSource = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv[2];
const log = (event) => fs.appendFileSync(process.env.STOP_EVIDENCE, JSON.stringify({pid:process.pid,at:Date.now(),event})+'\\n');
if (mode.startsWith('orphan-')) {
  spawn(process.execPath, [process.env.STOP_ORPHAN_ENTRY], {stdio:'ignore',env:{...process.env,STOP_DRAIN:String(mode === 'orphan-drain')}});
  process.on('SIGTERM', () => { fs.writeFileSync(process.env.STOP_FLAG, 'stop'); process.exit(0); });
} else {
  process.on('SIGTERM', () => {
    log('signal');
    if (mode !== 'ignore') setTimeout(() => { log('drained'); process.exit(0); }, 700);
  });
}
log('ready');
setInterval(() => {}, 1000);
`;
// Child branch must not recursively spawn another orphan fixture.
const orphanSource = `
import fs from 'node:fs';
const log = (event) => fs.appendFileSync(process.env.STOP_EVIDENCE, JSON.stringify({pid:process.pid,at:Date.now(),event})+'\\n');
log('child-ready');
process.on('SIGTERM', () => log('child-signal'));
let finishing = false;
setInterval(() => {
  if (!finishing && process.env.STOP_DRAIN === 'true' && fs.existsSync(process.env.STOP_FLAG)) {
    finishing = true;
    setTimeout(() => { log('child-drained'); process.exit(0); }, 700);
  }
}, 50);
`;

export async function verifyProcessStop(sourceRoot, root) {
  await mkdir(root, { recursive: true });
  const require = createRequire(path.join(sourceRoot, "backend/package.json"));
  const tsx = require.resolve("tsx/cli");
  const entry = path.join(root, "fixture.mjs");
  const orphanEntry = path.join(root, "orphan.mjs");
  await writeFile(orphanEntry, orphanSource);
  await writeFile(entry, fixtureSource);
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: {
        dev: `${shellQuote(process.execPath)} ${shellQuote(tsx)} watch ${shellQuote(entry)} drain`,
      },
    }),
  );
  const owned = [];
  const childIdentities = [];
  let sequence = 0;
  async function events(file) {
    return (await readFile(file, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  }
  async function start(mode, watcher = false) {
    const evidence = path.join(root, `${sequence++}-${mode}.jsonl`);
    const processInfo = spawnDetached({
      name: "shutdown verifier",
      command: watcher ? "pnpm" : process.execPath,
      args: watcher ? ["-C", root, "dev"] : [entry, mode],
      cwd: sourceRoot,
      env: {
        ...process.env,
        STOP_EVIDENCE: evidence,
        STOP_FLAG: `${evidence}.flag`,
        STOP_ORPHAN_ENTRY: orphanEntry,
      },
      logPath: `${evidence}.log`,
    });
    owned.push(processInfo);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const recorded = await events(evidence);
      const child = recorded.find((event) => event.event === "child-ready");
      if (
        recorded.some((event) => event.event === "ready") &&
        (!mode.startsWith("orphan-") || child)
      ) {
        processInfo.processSignature = readProcessSignature(processInfo.pid);
        if (child)
          childIdentities.push({
            pid: child.pid,
            processSignature: readProcessSignature(child.pid),
          });
        return { processInfo, evidence, child };
      }
      await pause(50);
    }
    throw new Error("shutdown fixture did not become ready");
  }
  try {
    for (const stop of [stopOwnedProcess, stopSpawnedProcess]) {
      const { processInfo, evidence } = await start("drain", true);
      assert.equal((await stop(processInfo)).outcome, "exited");
      const recorded = await events(evidence);
      assert.equal(
        recorded.filter((event) => event.event === "signal").length,
        1,
      );
      assert.equal(
        recorded.filter((event) => event.event === "drained").length,
        1,
      );
      assert(
        !/Force killing|Process hasn't exited/.test(
          await readFile(`${evidence}.log`, "utf8"),
        ),
      );
      assert.deepEqual(readOwnedProcessGroup(processInfo.pid), []);
      assert.equal((await stop(processInfo)).outcome, "already-stopped");
    }
    const slow = await start("ignore");
    const stopStartedAt = Date.now();
    assert.equal((await stopOwnedProcess(slow.processInfo)).outcome, "forced");
    assert(
      Date.now() - stopStartedAt >= 5_000,
      "force escalation skipped the grace period",
    );
    assert.equal(
      (await events(slow.evidence)).filter((event) => event.event === "signal")
        .length,
      1,
    );
    assert.deepEqual(readOwnedProcessGroup(slow.processInfo.pid), []);

    const earlyExit = await start("orphan-drain");
    assert.equal(
      (await stopOwnedProcess(earlyExit.processInfo)).outcome,
      "exited",
    );
    assert(
      (await events(earlyExit.evidence)).some(
        (event) => event.event === "child-drained",
      ),
    );
    assert.deepEqual(readOwnedProcessGroup(earlyExit.processInfo.pid), []);

    const orphan = await start("orphan-stuck");
    await assert.rejects(
      stopOwnedProcess({
        pid: orphan.child.pid,
        processSignature: readProcessSignature(orphan.child.pid),
      }),
      /not its process group leader/,
    );
    await assert.rejects(
      stopOwnedProcess(orphan.processInfo),
      /identity no longer matches/,
    );
    await assert.rejects(
      stopOwnedProcess(orphan.processInfo),
      /identity no longer matches/,
    );
    assert(isProcessLive(orphan.child.pid));
    assert(
      !(await events(orphan.evidence)).some(
        (event) => event.event === "child-signal",
      ),
    );
    const env = {
      ...process.env,
      RUNWEAVE_DEV_SESSION_HOME: path.join(root, "registry"),
    };
    const manifest = createManifest({
      sourceRoot,
      sessionId: "dvs-shutdown-orphan",
    });
    manifest.state = "stale";
    manifest.services.backend = {
      ownership: "dedicated",
      process: orphan.processInfo,
      pid: orphan.processInfo.pid,
      url: "http://127.0.0.1:65530",
      lockPath: path.join(root, "missing-lock"),
    };
    await writeManifest(manifest, env);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/dev-session/cli.mjs",
          "stop",
          "--session",
          manifest.devSessionId,
          "--cleanup-stale",
          "--json",
        ],
        { cwd: sourceRoot, env },
      ),
      (error) => error.code === 5,
    );
    assert.equal(
      (await readManifest(manifest.devSessionId, env)).state,
      "stale",
    );
    assert(isProcessLive(orphan.child.pid));

    const dedicated = await start("drain");
    const shared = await start("drain");
    await assert.rejects(
      stopOwnedProcess({
        ...dedicated.processInfo,
        processSignature: "mismatched-owner",
      }),
      /identity no longer matches/,
    );
    assert(isProcessLive(dedicated.processInfo.pid));
    assert(isProcessLive(shared.processInfo.pid));
    assert(
      !(await events(dedicated.evidence)).some(
        (event) => event.event === "signal",
      ),
    );
    const services = {
      frontend: { ownership: "dedicated", process: dedicated.processInfo },
      backend: { ownership: "shared-declared", process: shared.processInfo },
    };
    await stopSessionServices(services, { identityVerified: true });
    assert.equal(services.frontend.stopResult.outcome, "exited");
    assert(isProcessLive(shared.processInfo.pid));
    assert(
      !(await events(shared.evidence)).some(
        (event) => event.event === "signal",
      ),
    );
    await stopOwnedProcess(shared.processInfo);
    return [
      "single-launcher-signal",
      "rollback-signal-parity",
      "bounded-force-stop",
      "wait-for-orphan-drain",
      "orphan-stale-fail-closed",
      "pid-signature-gate",
      "shared-process-preserved",
    ];
  } finally {
    for (const info of [...childIdentities, ...owned]) {
      if (processIdentityMatches(info)) process.kill(info.pid, "SIGKILL");
    }
    for (const info of owned) {
      const deadline = Date.now() + 2_000;
      while (readOwnedProcessGroup(info.pid).length && Date.now() < deadline)
        await pause(50);
      assert.deepEqual(
        readOwnedProcessGroup(info.pid),
        [],
        "shutdown verifier leaked a process group",
      );
    }
  }
}
