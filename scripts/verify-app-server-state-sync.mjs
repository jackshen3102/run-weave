import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStateSyncHarness } from "./lib/app-server-state-sync-harness.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requireFromAppServer = createRequire(
  new URL("../app-server/package.json", import.meta.url),
);
const { WebSocket } = requireFromAppServer("ws");

const ids = {
  projectId: "project-state-sync-001",
  terminalSessionId: "terminal-state-sync-001",
  terminalPanelId: "panel-main-001",
  runId: "run-state-sync-001",
  threadId: "thread-state-sync-001",
  cwd: "/tmp/runweave-state-sync",
};

const source = {
  app: "hook",
  instanceId: "hook-state-sync-test",
  pid: 12345,
};

const stateDir = await mkdtemp(
  path.join(os.tmpdir(), "runweave-app-server-state-sync-"),
);
const syncDir = await mkdtemp(
  path.join(os.tmpdir(), "runweave-app-server-cloud-sync-"),
);
const badSyncPath = path.join(os.tmpdir(), `runweave-sync-file-${process.pid}`);
const fakeCodexBinPath = path.join(stateDir, "fake-codex-app-server.mjs");

const {
  assertStatus,
  collectLiveEvents,
  completionEvent,
  connectStream,
  contextTokenPattern,
  getJson,
  getThread,
  hookEvent,
  postEvent,
  readContext,
  readJson,
  readJsonl,
  run,
  startAppServer,
  stopAppServer,
  waitFor,
  writeFakeCodexBin,
} = createStateSyncHarness({
  WebSocket,
  fakeCodexBinPath,
  ids,
  repoRoot,
  source,
});

let appServer = null;
try {
  await run("pnpm", ["--filter", "@runweave/app-server", "build"]);
  await writeFakeCodexBin(fakeCodexBinPath);
  appServer = await startAppServer({ stateDir, syncDir });
  let context = await readContext(stateDir);

  await verifyStateProjection(context, syncDir);
  await verifyCompletionSemantics(context);
  await verifyIsolationAndFallbackKeys(context);
  await verifyDedupe(context, syncDir);
  await verifyFilteringAndAuth(context);
  await verifyWebSocketStateEvents(context);
  await verifyCodexThreadStatusCompensation(context);
  await verifyUnknownTraeLifecycleNoop();
  await verifyLargeEventPaging(context, syncDir);
  await verifySyncFiles(syncDir);

  await stopAppServer(appServer);
  appServer = await startAppServer({ stateDir, syncDir });
  context = await readContext(stateDir);
  await verifyRestartRecovery(context);

  await unlink(path.join(stateDir, "app-server-thread-state.json"));
  await rm(path.join(syncDir, "projections", "latest-threads.json"), {
    force: true,
  });
  await stopAppServer(appServer);
  appServer = await startAppServer({ stateDir, syncDir });
  context = await readContext(stateDir);
  await verifyProjectionRebuild(context, syncDir);

  await stopAppServer(appServer);
  appServer = null;
  await writeFile(badSyncPath, "not-a-directory", "utf8");
  const badSyncStateDir = await mkdtemp(
    path.join(os.tmpdir(), "runweave-app-server-bad-sync-"),
  );
  let badSyncServer = null;
  try {
    badSyncServer = await startAppServer({
      stateDir: badSyncStateDir,
      syncDir: badSyncPath,
    });
    const badContext = await readContext(badSyncStateDir);
    await verifySyncDegrades(badContext);
  } finally {
    if (badSyncServer) {
      await stopAppServer(badSyncServer);
    }
    await rm(badSyncStateDir, { recursive: true, force: true });
  }

  console.log("app-server state sync verification passed");
} finally {
  if (appServer) {
    await stopAppServer(appServer);
  }
  await rm(stateDir, { recursive: true, force: true });
  await rm(syncDir, { recursive: true, force: true });
  await rm(badSyncPath, { force: true });
}

async function verifyStateProjection(context, syncDir) {
  const sessionStart = await postEvent(context, hookEvent("SessionStart"));
  assert.equal(sessionStart.status, 201);
  const thread = await getThread(context, ids.threadId);
  assert.equal(thread.thread.threadId, ids.threadId);
  assert.equal(thread.thread.agent, "codex");
  assert.equal(thread.thread.status, "starting");
  assert.equal(thread.thread.projectId, ids.projectId);
  assert.equal(thread.thread.terminalSessionId, ids.terminalSessionId);
  assert.equal(thread.thread.terminalPanelId, ids.terminalPanelId);
  assert.equal(thread.thread.cwd, ids.cwd);
  assert.equal(thread.thread.lastEventId, sessionStart.body.event.id);

  const threadProjectionLines = await readJsonl(
    path.join(syncDir, "projections", "threads.jsonl"),
  );
  assert.equal(threadProjectionLines.at(-1).threadId, ids.threadId);

  const running = await postEvent(context, hookEvent("UserPromptSubmit"));
  assert.equal(running.status, 201);
  const runningThreads = await getJson(
    context,
    `/threads?projectId=${ids.projectId}&agent=codex&status=running`,
  );
  assert.equal(runningThreads.threads.length, 1);
  assert.equal(runningThreads.threads[0].status, "running");
}

async function verifyCompletionSemantics(context) {
  await postEvent(context, hookEvent("Stop"));
  assert.equal((await getThread(context, ids.threadId)).thread.status, "idle");
  assert.equal(
    (await getThread(context, ids.threadId)).thread.lastHookEvent,
    "Stop",
  );

  await postEvent(context, hookEvent("UserPromptSubmit"));
  await postEvent(context, completionEvent("notify", "Notify"));
  assert.equal(
    (await getThread(context, ids.threadId)).thread.status,
    "running",
  );

  await postEvent(context, completionEvent("hook_stop", "Stop"));
  const idleThread = await getThread(context, ids.threadId);
  assert.equal(idleThread.thread.status, "idle");
  assert.equal(idleThread.thread.lastCompletionReason, "hook_stop");

  await postEvent(context, hookEvent("UserPromptSubmit"));
  await postEvent(context, completionEvent("ai_process_exit", "Exit"));
  const completed = await getThread(context, ids.threadId);
  assert.equal(completed.thread.status, "completed");
  assert.equal(completed.thread.lastCompletionReason, "ai_process_exit");
}

async function verifyIsolationAndFallbackKeys(context) {
  await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: "thread-state-sync-trae-001",
      payload: { source: "trae", stateHookEvent: "UserPromptSubmit" },
    }),
  );
  assert.equal(
    (await getThread(context, "thread-state-sync-trae-001")).thread.agent,
    "trae",
  );
  assert.equal((await getThread(context, ids.threadId)).thread.agent, "codex");

  await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: "thread-claude-source-codex-command",
      payload: {
        source: "claude",
        commandName: "codex",
        stateHookEvent: "UserPromptSubmit",
      },
    }),
  );
  const codexCommandThread = await getThread(
    context,
    "thread-claude-source-codex-command",
  );
  assert.equal(codexCommandThread.thread.agent, "codex");
  assert.equal(codexCommandThread.thread.status, "running");

  await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: "thread-panel-a",
      scope: { terminalPanelId: "panel-a" },
    }),
  );
  await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: "thread-panel-b",
      scope: { terminalPanelId: "panel-b" },
    }),
  );
  await postEvent(
    context,
    hookEvent("Stop", {
      correlationId: "thread-panel-a",
      scope: { terminalPanelId: "panel-a" },
    }),
  );
  assert.equal(
    (await getThread(context, "thread-panel-a")).thread.status,
    "idle",
  );
  assert.equal(
    (await getThread(context, "thread-panel-b")).thread.status,
    "running",
  );

  await postEvent(
    context,
    hookEvent("SessionStart", {
      correlationId: null,
      scope: { terminalPanelId: "panel-fallback" },
    }),
  );
  const fallbackThreads = await getJson(
    context,
    "/threads?terminalPanelId=panel-fallback",
  );
  assert.equal(fallbackThreads.threads.length, 1);
  assert.equal(fallbackThreads.threads[0].status, "starting");

  await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: "thread-fallback-real",
      scope: { terminalPanelId: "panel-fallback" },
    }),
  );
  const migratedThreads = await getJson(
    context,
    "/threads?terminalPanelId=panel-fallback&status=running",
  );
  assert.equal(migratedThreads.threads.length, 1);
  assert.equal(migratedThreads.threads[0].threadId, "thread-fallback-real");

  const crossSourcePanelId = "panel-fallback-cross-source";
  await postEvent(
    context,
    hookEvent("SessionStart", {
      correlationId: null,
      scope: { terminalPanelId: crossSourcePanelId },
      payload: { source: "traex", stateHookEvent: "SessionStart" },
    }),
  );
  await postEvent(context, {
    kind: "agent.lifecycle.observed",
    source: {
      app: "app-server",
      instanceId: "app-server-reconciler-test",
      pid: process.pid,
    },
    scope: {
      projectId: ids.projectId,
      terminalSessionId: ids.terminalSessionId,
      terminalPanelId: crossSourcePanelId,
      runId: ids.runId,
      cwd: ids.cwd,
    },
    correlationId: "thread-fallback-cross-source-real",
    payload: {
      source: "traex",
      observedStatus: "running",
      lifecycleStatus: "available",
      observedLifecycle: "task_started",
      lifecycleCursor: "1",
    },
  });
  const crossSourceThreads = await getJson(
    context,
    `/threads?terminalPanelId=${crossSourcePanelId}`,
  );
  assert.deepEqual(
    crossSourceThreads.threads.map((thread) => thread.threadId),
    ["thread-fallback-cross-source-real"],
  );
}

async function verifyDedupe(context, syncDir) {
  const beforeProjectionLines = (
    await readJsonl(path.join(syncDir, "projections", "threads.jsonl"))
  ).length;
  const body = hookEvent("UserPromptSubmit", {
    correlationId: "thread-dedupe",
    dedupeKey: "state-sync-dedupe",
  });
  const first = await postEvent(context, body);
  const second = await postEvent(context, body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.event.id, first.body.event.id);
  const afterProjectionLines = (
    await readJsonl(path.join(syncDir, "projections", "threads.jsonl"))
  ).length;
  assert.equal(afterProjectionLines, beforeProjectionLines + 1);
}

async function verifyFilteringAndAuth(context) {
  await assertStatus(context, "/threads", 401, null);
  await assertStatus(context, "/sync/status", 401, null);
  await assertStatus(context, "/threads", 401, "wrong-token");
  await assertStatus(context, "/healthz", 200, null);
  await assertStatus(context, "/readyz", 200, null);

  await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: "thread-other-project",
      scope: { projectId: "project-other" },
    }),
  );
  const filtered = await getJson(
    context,
    `/threads?projectId=${ids.projectId}&terminalSessionId=${ids.terminalSessionId}&terminalPanelId=${ids.terminalPanelId}&agent=codex&limit=50`,
  );
  assert.equal(
    filtered.threads.every((thread) => thread.projectId === ids.projectId),
    true,
  );
  assert.equal(
    filtered.threads.every((thread) => thread.agent === "codex"),
    true,
  );
}

async function verifyWebSocketStateEvents(context) {
  const stream = await connectStream(
    `${context.baseUrl.replace(/^http/, "ws")}/events/stream?kind=thread.state.changed`,
    context.token,
  );
  const liveEvents = collectLiveEvents(stream, 1);
  await postEvent(
    context,
    hookEvent("UserPromptSubmit", { correlationId: "thread-ws-live" }),
  );
  const messages = await liveEvents;
  assert.equal(messages.length, 1);
  assert.equal(
    messages.some((event) => event.kind === "thread.state.changed"),
    true,
  );
  stream.close();
}

async function verifyCodexThreadStatusCompensation(context) {
  const threadId = "thread-compensation";
  const activeThreadId = "thread-active-compensation";
  const running = await postEvent(
    context,
    hookEvent("UserPromptSubmit", {
      correlationId: threadId,
      scope: { terminalPanelId: "panel-compensation" },
    }),
  );
  assert.equal(running.status, 201);
  assert.equal((await getThread(context, threadId)).thread.status, "running");

  await waitFor(async () => {
    const thread = await getThread(context, threadId);
    return thread.thread.status === "idle" ? thread : null;
  });
  const events = await getJson(
    context,
    `/events?after=${running.body.event.id}&kind=agent.lifecycle.observed&limit=50`,
  );
  const compensationEvent = events.events.find(
    (event) =>
      event.correlationId === threadId && event.payload?.compensation === true,
  );
  assert.ok(compensationEvent);
  assert.equal(compensationEvent.payload.source, "codex");
  assert.equal(compensationEvent.payload.observedStatus, "idle");
  assert.equal(compensationEvent.payload.observedLifecycle, "thread/read:idle");
  assert.equal(
    compensationEvent.payload.compensationReason,
    "codex_thread_status_mismatch",
  );

  await postEvent(
    context,
    hookEvent("Stop", {
      correlationId: activeThreadId,
      scope: { terminalPanelId: "panel-active-compensation" },
    }),
  );
  assert.equal(
    (await getThread(context, activeThreadId)).thread.status,
    "idle",
  );

  await waitFor(async () => {
    const thread = await getThread(context, activeThreadId);
    return thread.thread.status === "running" ? thread : null;
  });
  const activeEvents = await getJson(
    context,
    `/events?after=${running.body.event.id}&kind=agent.lifecycle.observed&limit=50`,
  );
  const activeCompensationEvent = activeEvents.events.find(
    (event) =>
      event.correlationId === activeThreadId &&
      event.payload?.compensation === true,
  );
  assert.ok(activeCompensationEvent);
  assert.equal(activeCompensationEvent.payload.observedStatus, "running");
  assert.equal(
    activeCompensationEvent.payload.observedLifecycle,
    "thread/read:active",
  );
}

async function verifyUnknownTraeLifecycleNoop() {
  const [{ AgentThreadStatusReconciler }, { AppServerStateStore }] =
    await Promise.all([
      import("../app-server/dist/agent-thread-status-reconciler.js"),
      import("../app-server/dist/state-store.js"),
    ]);
  const stateStore = new AppServerStateStore(
    path.join(stateDir, "unknown-lifecycle-thread-state.json"),
  );
  const now = new Date().toISOString();
  stateStore.upsertThread({
    agent: "traex",
    status: "running",
    threadId: "thread-unknown-lifecycle",
    projectId: ids.projectId,
    terminalSessionId: ids.terminalSessionId,
    terminalPanelId: "panel-unknown-lifecycle",
    terminalTmuxPaneId: null,
    runId: ids.runId,
    cwd: ids.cwd,
    sourceInstanceId: source.instanceId,
    lastEventId: "1",
    lastActivityAt: now,
    updatedAt: now,
  });
  const recorded = [];
  const reconciler = new AgentThreadStatusReconciler({
    eventCenter: {
      getStateStore: () => stateStore,
      record: async (input) => {
        recorded.push(input);
        return { created: true, event: { id: "2" } };
      },
    },
    codexStatusReader: {
      readThreadStatus: async () => null,
      shutdown() {},
    },
    traeLifecycleReader: {
      readThread: async () => ({
        provider: "traex",
        id: "thread-unknown-lifecycle",
        status: "unknown",
        preview: null,
        turns: [],
        lifecycle: [
          {
            cursor: "2",
            type: "future_lifecycle",
            timestamp: null,
            turnId: null,
            raw: { type: "future_lifecycle" },
          },
        ],
        lastLifecycleCursor: "2",
        sourcePath: null,
      }),
      shutdown() {},
    },
    sourceInstanceId: "app-server-reconciler-test",
  });
  await reconciler.reconcileOnce();
  assert.equal(recorded.length, 0);
}

async function verifyLargeEventPaging(context, syncDir) {
  for (let index = 0; index < 1200; index += 1) {
    await postEvent(context, {
      kind: "diagnostic.created",
      source,
      payload: { index },
    });
  }
  const page = await getJson(context, "/events?after=0&limit=1200");
  assert.equal(page.events.length, 500);
  const mirror = await readJsonl(
    path.join(syncDir, "events", "app-server-events.jsonl"),
  );
  assert.ok(mirror.length >= 1200);
}

async function verifySyncFiles(syncDir) {
  const events = await readJsonl(
    path.join(syncDir, "events", "app-server-events.jsonl"),
  );
  assert.ok(events.length > 0);
  const latestThreads = await readJson(
    path.join(syncDir, "projections", "latest-threads.json"),
  );
  assert.ok(Array.isArray(latestThreads));
  assert.equal(JSON.stringify(latestThreads).includes("Authorization"), false);
  const cursor = await readJson(
    path.join(syncDir, "cursors", "upload-cursor.json"),
  );
  assert.ok(cursor.latestSyncedEventId);
  const manifest = await readJson(
    path.join(syncDir, "manifests", "sync-manifest.json"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.syncDir, syncDir);
  assert.equal(JSON.stringify(manifest).includes(contextTokenPattern()), false);
}

async function verifyRestartRecovery(context) {
  const thread = await getThread(context, ids.threadId);
  assert.equal(thread.thread.status, "completed");
  const latest = await getJson(context, "/events/latest");
  const created = await postEvent(
    context,
    hookEvent("Stop", { correlationId: "thread-after-restart" }),
  );
  assert.ok(Number(created.body.event.id) > Number(latest.latestEventId));
}

async function verifyProjectionRebuild(context, syncDir) {
  const rebuilt = await getThread(context, ids.threadId);
  assert.equal(rebuilt.thread.status, "completed");
  const latestThreads = await readJson(
    path.join(syncDir, "projections", "latest-threads.json"),
  );
  assert.equal(
    latestThreads.some((thread) => thread.threadId === ids.threadId),
    true,
  );
}

async function verifySyncDegrades(context) {
  const response = await postEvent(context, hookEvent("SessionStart"));
  assert.equal(response.status, 201);
  assert.equal(
    (await getThread(context, ids.threadId)).thread.status,
    "starting",
  );
  const status = await getJson(context, "/sync/status");
  assert.ok(status.lastError);
}
