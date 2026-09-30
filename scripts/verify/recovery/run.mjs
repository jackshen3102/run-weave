import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsxImport } from "./configuration.mjs";

const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const repoRoot = path.resolve(
  option("--repo") ?? fileURLToPath(new URL("../../../", import.meta.url)),
);
const output = path.resolve(
  option("--output") ?? path.join(repoRoot, ".runweave/recovery-verification"),
);
const expectRegressions = args.includes("--expect-regressions");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rw-recovery-"));
const results = [];
let completed = false;
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const verifierHash = createHash("sha256");
for (const script of [
  "run.mjs",
  "activity-probe.mjs",
  "events-probe.mjs",
  "configuration.mjs",
]) {
  verifierHash.update(await readFile(new URL(script, import.meta.url)));
}
const verifierSHA256 = verifierHash.digest("hex");
await mkdir(output, { recursive: true });

function launch(script, argumentsList) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsxImport,
      fileURLToPath(new URL(script, import.meta.url)),
      repoRoot,
      ...argumentsList,
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

const observations = (stdout) =>
  stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

async function verifyActivity(mode) {
  const probe = await launch("activity-probe.mjs", [mode, fixtureRoot]).done;
  await writeFile(
    path.join(output, `activity-${mode}.log`),
    probe.stdout + probe.stderr,
  );
  assert.equal(probe.code, 0, probe.stderr);
  const values = observations(probe.stdout);
  const byLabel = (label) => values.find((value) => value.label === label);
  const cause = {
    zero: /^rejected:activity_sqlite_worker_exited:0$/,
    nonzero: /^rejected:activity_sqlite_worker_exited:17$/,
    error: /^rejected:injected-worker-error$/,
    silent: /^rejected:activity_sqlite_worker_timeout:/,
    "silent-close": /^rejected:activity_store_closed$/,
    "startup-silent": /^rejected:activity_sqlite_worker_timeout:ready$/,
  }[mode];
  const rejected = (label) => cause.test(byLabel(label)?.result ?? "");
  let passed = probe.code === 0;
  if (mode === "startup-silent") {
    passed &&= rejected("startup");
  } else {
    passed &&= byLabel("initial-runtime-status")?.state === "healthy";
    passed &&= rejected("pending-query") && rejected("pending-record");
    if (mode === "silent-close") {
      passed &&= byLabel("idempotent-close")?.samePromise === true;
      passed &&= byLabel("close-with-pending")?.result === "resolved";
      passed &&= byLabel("close-with-pending")?.elapsedMs < 3_000;
      passed &&= byLabel("closed-runtime-status")?.state === "unhealthy";
    } else {
      passed &&=
        byLabel(
          mode === "silent"
            ? "runtime-status-after-timeout"
            : "runtime-status-after-failure",
        )?.state === "unhealthy";
      for (const label of [
        "later-query",
        "later-record",
        "later-facts",
        "later-evolution",
      ]) {
        passed &&= rejected(label) && byLabel(label)?.elapsedMs < 250;
      }
      passed &&= byLabel("close")?.result === "resolved";
    }
  }
  return {
    area: "activity",
    mode,
    passed: Boolean(passed),
    exitCode: probe.code,
    observations: values,
  };
}

async function verifyEvents(mode, stage) {
  const root = await mkdtemp(path.join(fixtureRoot, "events-"));
  const seeded = await launch("events-probe.mjs", ["seed", root]).done;
  assert.equal(seeded.code, 0, seeded.stderr);
  const fault = await launch("events-probe.mjs", [mode, root, stage]).done;
  const server = launch("events-probe.mjs", ["boot", root]);
  const stateDir = path.join(root, "data/app-server");
  let passed = true;
  let details = {};
  try {
    let context;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.child.exitCode !== null)
        throw new Error((await server.done).stderr);
      try {
        const lock = JSON.parse(
          await readFile(path.join(stateDir, "app-server.lock.json"), "utf8"),
        );
        const token = (
          await readFile(path.join(stateDir, "app-server-token"), "utf8")
        ).trim();
        const url = `http://${lock.host}:${lock.port}`;
        if ((await fetch(`${url}/readyz`)).ok) {
          context = { url, headers: { Authorization: `Bearer ${token}` } };
          break;
        }
      } catch {
        /* Wait for this fixture process only. */
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    assert(context, "isolated App Server did not become ready");
    const get = async (endpoint) => {
      const response = await fetch(context.url + endpoint, {
        headers: context.headers,
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const expected = JSON.parse(
      await readFile(path.join(root, "expected.json"), "utf8"),
    );
    const events = (await get("/events?after=0&limit=100")).events;
    const threads = (await get("/threads")).threads;
    const appends = JSON.parse(
      await readFile(path.join(root, "appends.json"), "utf8").catch(() => "[]"),
    );
    const acknowledged = appends
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.event);
    const mirror = (
      await readFile(
        path.join(stateDir, "cloud-sync/events/app-server-events.jsonl"),
        "utf8",
      )
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const expectedExit =
      { "truncate-crash": 73, "before-rename": 74, "after-rename": 75 }[mode] ??
      0;
    const injected = observations(fault.stdout).some(
      (value) => value.injected === true,
    );
    const unsupported =
      !injected && ["before-rename", "after-rename"].includes(mode);
    details = {
      retainedIds: events
        .filter((event) => Number(event.id) <= 4)
        .map((event) => event.id),
      acknowledged: acknowledged.length,
      eventCount: events.length,
      injected,
      unsupported,
    };
    assert.equal(fault.code, unsupported ? 0 : expectedExit, fault.stderr);
    if (mode !== "success" && !unsupported)
      assert(injected, "fault was not injected");
    try {
      assert.deepEqual(
        events.filter((event) => Number(event.id) <= 4),
        expected.events,
      );
      assert.deepEqual(threads, expected.threads);
      assert.deepEqual(
        mirror.filter((event) => Number(event.id) <= 4),
        expected.events,
      );
      assert.equal(
        new Set(events.map((event) => event.id)).size,
        events.length,
      );
      if (stage === "runtime") {
        assert.deepEqual(
          events.filter((event) => Number(event.id) > 4),
          acknowledged,
        );
        if (["success", "partial-fail"].includes(mode))
          assert.equal(acknowledged.length, mode === "success" ? 20 : 19);
      }
    } catch (error) {
      passed = false;
      details.error = error.message;
    }
  } finally {
    if (server.child.exitCode === null) server.child.kill("SIGTERM");
    const boot = await server.done;
    await writeFile(
      path.join(output, `events-${mode}-${stage}.log`),
      fault.stdout + fault.stderr + boot.stdout + boot.stderr,
    );
  }
  return {
    area: "events",
    mode,
    stage,
    passed: details.unsupported ? null : passed,
    ...details,
  };
}

try {
  for (const mode of [
    "zero",
    "nonzero",
    "error",
    "silent",
    "silent-close",
    "startup-silent",
  ]) {
    const result = await verifyActivity(mode);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  for (const mode of [
    "truncate-crash",
    "partial-fail",
    "before-rename",
    "after-rename",
    "success",
  ]) {
    for (const stage of ["startup", "runtime"]) {
      const result = await verifyEvents(mode, stage);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const failures = results.filter((result) => result.passed === false);
  const unsupported = results.filter((result) => result.unsupported);
  if (expectRegressions) {
    assert.equal(
      results.filter(
        (result) => result.area === "activity" && result.passed === false,
      ).length,
      6,
    );
    assert.equal(
      results.filter(
        (result) => result.area === "events" && result.passed === false,
      ).length,
      4,
    );
    assert.equal(unsupported.length, 4);
  } else {
    assert.equal(failures.length, 0, JSON.stringify(failures));
    assert.equal(
      unsupported.length,
      0,
      "every repaired retention boundary must be exercised",
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      cases: results.length,
      failures: failures.length,
      unsupported: unsupported.length,
      expectRegressions,
    }),
  );
  completed = true;
} finally {
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        completed,
        repoRoot,
        sourceRevision,
        verifierSHA256,
        nodeVersion: process.version,
        expectRegressions,
        results,
      },
      null,
      2,
    ),
  );
  await rm(fixtureRoot, { recursive: true, force: true });
}
