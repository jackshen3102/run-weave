import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repoRoot = path.resolve(process.argv[2]);
const { ActivityStore } = await import(
  pathToFileURL(path.join(repoRoot, "backend/src/activity/recording/store.ts"))
    .href
);
const { ActivityEventFactory } = await import(
  pathToFileURL(
    path.join(repoRoot, "backend/src/activity/recording/event-factory.ts"),
  ).href
);
const { BackendRuntimeStatusService } = await import(
  pathToFileURL(path.join(repoRoot, "backend/src/runtime-status/service.ts"))
    .href
);

async function observe(label, operation, limit) {
  const started = Date.now();
  let timeout;
  const result = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => `rejected:${error.message}`,
    ),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve("HUNG"), limit);
    }),
  ]);
  clearTimeout(timeout);
  console.log(
    JSON.stringify({ label, result, elapsedMs: Date.now() - started }),
  );
  return result;
}

async function waitUntil(predicate, limit = 12_000) {
  const deadline = Date.now() + limit;
  while (!(await predicate())) {
    assert(
      Date.now() < deadline,
      "worker recovery did not reach expected state",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function verifyRecovery(mode, directory) {
  const entry = path.join(directory, "recover-worker.cjs");
  const starts = path.join(directory, "worker-starts.jsonl");
  const require = createRequire(path.join(repoRoot, "backend/package.json"));
  await writeFile(
    entry,
    `
    const fs = require('node:fs');
    const {parentPort} = require('node:worker_threads');
    const starts = ${JSON.stringify(starts)};
    const generation = fs.existsSync(starts) ? fs.readFileSync(starts,'utf8').trim().split(String.fromCharCode(10)).length + 1 : 1;
    fs.appendFileSync(starts, JSON.stringify({generation, at:Date.now()})+String.fromCharCode(10));
    const mode = ${JSON.stringify(mode)};
    if (mode === 'recover-close-startup' && generation > 1) {
      parentPort.on('message', () => {});
    } else if (mode === 'recover-backoff' && generation > 1 && generation < 4) {
      throw new Error('injected-recovery-startup-failure');
    } else {
      if (generation === 1 && mode === 'recover-queue') {
        parentPort.on('message', request => {
          const wait = new Int32Array(new SharedArrayBuffer(4));
          if(request.op === 'sources') Atomics.wait(wait,0,0,9000);
          if(request.op === 'run-retention') Atomics.wait(wait,0,0,2000);
        });
      } else if (generation === 1 && mode !== 'recover-stop') {
        parentPort.on('message', request => {
          if (request.op === 'sources') {
            if(mode === 'recover-error') throw new Error('injected-worker-error');
            process.exit(mode === 'recover-zero' ? 0 : 17);
          }
        });
      }
      require(${JSON.stringify(require.resolve("tsx/cjs"))});
      require(${JSON.stringify(path.join(repoRoot, "backend/src/activity/database/sqlite-worker.ts"))});
    }
  `,
  );
  const store = await ActivityStore.create({
    databasePath: path.join(directory, "activity.sqlite"),
    env: {
      ...process.env,
      RUNWEAVE_ACTIVITY_WORKER_ENTRY: entry,
      RUNWEAVE_ACTIVITY_TEST_MODE: "true",
      RUNWEAVE_ACTIVITY_TEST_KEY: Buffer.alloc(32, 19).toString("base64"),
    },
  });
  const { ActivityQueryService } = await import(
    pathToFileURL(
      path.join(repoRoot, "backend/src/activity/database/service.ts"),
    ).href
  );
  const { ActivityRecorder } = await import(
    pathToFileURL(
      path.join(repoRoot, "backend/src/activity/recording/recorder.ts"),
    ).href
  );
  const query = new ActivityQueryService(store);
  const recorder = new ActivityRecorder(store);
  const factory = new ActivityEventFactory({
    producerName: "recovery-verify",
    producerVersion: "1",
    producerInstanceId: mode,
    runtimeChannel: "dev",
    runtimeSurface: "backend",
  });
  const event = () =>
    factory.create({
      eventName: "producer.instance.started",
      payload: { fixture: true },
    });
  const historical = event();
  assert.equal(
    (await recorder.recordBatch([historical]))[0].status,
    "committed",
  );
  try {
    if (mode === "recover-stop") {
      const retention = observe(
        "pending-retention",
        store.runRetention("recovery-verify"),
        15_000,
      );
      console.log(JSON.stringify({ label: "suspend-ready", pid: process.pid }));
      process.kill(process.pid, "SIGSTOP");
      assert.match(
        await retention,
        /^rejected:activity_sqlite_worker_timeout:run-retention$/,
      );
    } else if (mode === "recover-queue") {
      const first = observe("first-query", store.sources(), 11_000);
      const retention = observe(
        "pending-retention",
        store.runRetention("recovery-verify"),
        11_000,
      );
      assert.equal(await first, "resolved");
      assert.match(
        await retention,
        /^rejected:activity_sqlite_worker_timeout:run-retention$/,
      );
    } else if (mode === "recover-error") {
      await observe("query-before-worker-error", store.sources(), 1000);
      await waitUntil(() => !store.isAvailable(), 1000);
      assert.match(
        await observe("worker-error", store.sources(), 1000),
        /^rejected:injected-worker-error$/,
      );
    } else {
      assert.match(
        await observe("pending-query", store.sources(), 1000),
        /^rejected:/,
      );
    }
    assert.equal(store.isAvailable(), false);
    const rejected = event();
    assert.equal(
      (await recorder.recordBatch([rejected]))[0].status,
      "rejected",
    );
    if (mode.startsWith("recover-close")) {
      if (mode === "recover-close-startup") {
        await waitUntil(
          async () =>
            (await readFile(starts, "utf8")).trim().split("\n").length === 2,
        );
      }
      const closing = store.close();
      assert.equal(store.close(), closing);
      assert.equal(
        await observe("close-during-recovery", closing, 3500),
        "resolved",
      );
      const generations = (await readFile(starts, "utf8"))
        .trim()
        .split("\n").length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        (await readFile(starts, "utf8")).trim().split("\n").length,
        generations,
      );
      assert.equal(store.isAvailable(), false);
      await assert.rejects(store.sources(), /activity_store_closed/);
      console.log(
        JSON.stringify({ label: "recovery-closed", passed: true, generations }),
      );
      return;
    }
    await waitUntil(() => store.isAvailable());
    const fresh = event();
    assert.equal((await recorder.recordBatch([fresh]))[0].status, "committed");
    const facts = (await query.facts({ limit: 10 })).facts;
    assert(facts.some((fact) => fact.eventId === historical.eventId));
    assert(facts.some((fact) => fact.eventId === fresh.eventId));
    assert(!facts.some((fact) => fact.eventId === rejected.eventId));
    const generations = (await readFile(starts, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    if (mode === "recover-backoff") {
      assert.equal(generations.length, 4);
      for (let index = 1; index < generations.length; index++) {
        assert(
          generations[index].at - generations[index - 1].at >=
            900 * 2 ** (index - 1),
        );
      }
    } else assert.equal(generations.length, 2);
    console.log(
      JSON.stringify({
        label: "recovered",
        passed: true,
        historicalReadable: true,
        newEventReadable: true,
        rejectedEventReplayed: false,
        generations,
      }),
    );
  } finally {
    await store.close();
  }
}

async function main() {
  const mode = process.argv[3];
  const directory = await mkdtemp(path.join(process.argv[4], "activity-"));
  if (mode.startsWith("recover-")) {
    await verifyRecovery(mode, directory);
    return;
  }
  const entry = path.join(directory, "worker.cjs");
  await writeFile(
    entry,
    `const {parentPort}=require('node:worker_threads');
    parentPort.on('message', request => {
      if(request.op==='ready' && ${JSON.stringify(mode)}!=='startup-silent') {
        parentPort.postMessage({id:request.id,ok:true,result:true}); return;
      }
      if(request.op==='sources') {
        if(${JSON.stringify(mode)}==='zero') setTimeout(()=>process.exit(0),80);
        if(${JSON.stringify(mode)}==='nonzero') setTimeout(()=>process.exit(17),80);
        if(${JSON.stringify(mode)}==='error') setTimeout(()=>{throw new Error('injected-worker-error')},80);
      }
    });`,
  );
  const creation = ActivityStore.create({
    databasePath: path.join(directory, "activity.sqlite"),
    env: { RUNWEAVE_ACTIVITY_WORKER_ENTRY: entry },
  });
  if (mode === "startup-silent") {
    await observe("startup", creation, 11000);
    process.exit(0);
  }
  const store = await creation;
  const statusService = new BackendRuntimeStatusService("recovery-probe", {
    activityStoreAvailable: () =>
      typeof store.isAvailable === "function" ? store.isAvailable() : true,
    evolutionRuntime: { getStatusSnapshot: () => ({ enabled: false }) },
    workspaceServiceManager: { getRuntimeStatusItems: async () => [] },
  });
  const health = async (label) => {
    const snapshot = await statusService.registry.getSnapshot();
    console.log(
      JSON.stringify({
        label,
        state: snapshot.reports
          .find((report) => report.source.id === "backend")
          ?.items.find((item) => item.id === "backend.activity-store")?.state,
      }),
    );
  };
  await health("initial-runtime-status");
  const factory = new ActivityEventFactory({
    producerName: "recovery-probe",
    producerVersion: "1",
    producerInstanceId: "probe",
    runtimeChannel: "dev",
    runtimeSurface: "backend",
  });
  const event = () =>
    factory.create({
      eventName: "terminal.session.created",
      payload: { fixture: true },
    });
  const pendingQuery = observe("pending-query", store.sources(), 11000);
  const pendingRecord = observe(
    "pending-record",
    store.record([event()]),
    11000,
  );
  if (mode === "silent-close") {
    const close = store.close();
    console.log(
      JSON.stringify({
        label: "idempotent-close",
        samePromise: close === store.close(),
      }),
    );
    await observe("close-with-pending", close, 3500);
    await health("closed-runtime-status");
    await Promise.all([pendingQuery, pendingRecord]);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(
    JSON.stringify({
      label: "health-after-failure",
      available:
        typeof store.isAvailable === "function"
          ? store.isAvailable()
          : "no-live-health",
    }),
  );
  await health("runtime-status-after-failure");
  if (mode === "silent") {
    await Promise.all([pendingQuery, pendingRecord]);
    await health("runtime-status-after-timeout");
  }
  await Promise.all([
    observe("later-query", store.sources(), 1000),
    observe("later-record", store.record([event()]), 1000),
    observe("later-facts", store.facts({}), 1000),
    observe("later-evolution", store.evolutionSnapshot({}), 1000),
  ]);
  await observe("close", store.close(), 3500);
  await Promise.all([pendingQuery, pendingRecord]);
  process.exit(0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
