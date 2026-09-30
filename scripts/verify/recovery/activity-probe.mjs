import { mkdtemp, writeFile } from "node:fs/promises";
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

async function main() {
  const mode = process.argv[3];
  const directory = await mkdtemp(path.join(process.argv[4], "activity-"));
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
    agentTeamService: {
      getRecheckWatchdogStatus: () => ({
        startedAt: Date.now(),
        lastCompletedAt: null,
        lastStartedAt: null,
        consecutiveFailures: 0,
      }),
    },
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
