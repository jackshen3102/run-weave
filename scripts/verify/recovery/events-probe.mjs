import fs from "node:fs/promises";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const repoRoot = path.resolve(process.argv[2]);
const { AppServerEventStore } = await import(
  pathToFileURL(path.join(repoRoot, "app-server/src/events/store.ts")).href
);
const { AppServerStateStore } = await import(
  pathToFileURL(path.join(repoRoot, "app-server/src/state/store.ts")).href
);
const { AppServerStateProjector } = await import(
  pathToFileURL(path.join(repoRoot, "app-server/src/state/projector.ts")).href
);
const { AppServerCloudSyncSim } = await import(
  pathToFileURL(path.join(repoRoot, "app-server/src/cloud-sync-sim.ts")).href
);
const { initializeConfiguration, prepareInitialConfiguration } = await import(
  pathToFileURL(path.join(repoRoot, "packages/config-node/src/index.ts")).href
);

async function main() {
  const [mode, root, stage = "startup"] = process.argv.slice(3);
  const stateDir = path.join(root, "data", "app-server");
  const log = path.join(stateDir, "app-server-events.jsonl");
  const syncDir = path.join(stateDir, "cloud-sync");
  if (mode === "seed") {
    const context = {
      kind: "dev",
      instanceId: "recovery-probe",
      configRoot: root,
    };
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(root, "settings.yaml"),
      JSON.stringify(
        prepareInitialConfiguration(context, {
          username: "probe",
          password: "isolated-password-12345",
        }),
      ),
      { mode: 0o600 },
    );
    await fs.mkdir(stateDir, { recursive: true });
    const now = Date.now();
    const source = { app: "hook", instanceId: "recovery-probe", pid: 123 };
    const envelope = (id, thread, hook, createdAt) => ({
      id: String(id),
      version: 1,
      kind: "agent.hook",
      source,
      scope: {
        terminalSessionId: "synthetic-session",
        terminalPanelId: "main",
        projectId: "fixture",
      },
      dedupeKey: `seed-${id}`,
      correlationId: thread,
      payload: {
        source: "claude",
        stateHookEvent: hook,
        fixture: `content-${id}`,
      },
      createdAt: new Date(createdAt).toISOString(),
    });
    const events = [
      envelope(1, "expired", "SessionStart", now - 8 * 86400000),
      envelope(2, "thread-a", "SessionStart", now - 10000),
      envelope(3, "thread-a", "UserPromptSubmit", now - 9000),
      envelope(4, "thread-b", "Stop", now - 8000),
    ];
    await fs.writeFile(
      log,
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const state = new AppServerStateStore(
      path.join(stateDir, "app-server-thread-state.json"),
    );
    await state.initialize();
    state.clear();
    const projector = new AppServerStateProjector(state);
    events.slice(1).forEach((event) => projector.project(event));
    await state.persist();
    const sync = new AppServerCloudSyncSim({
      syncDir,
      stateDir,
      instanceId: "fixture",
      version: "1",
    });
    await sync.initialize();
    await sync.sync({
      events: events.slice(1),
      ...state.getSnapshot(),
      threadChanges: state.getSnapshot().threads,
    });
    await fs.writeFile(
      path.join(root, "expected.json"),
      JSON.stringify({
        events: events.slice(1),
        threads: state.getSnapshot().threads,
      }),
    );
    return;
  }
  if (mode === "boot") {
    const context = {
      kind: "dev",
      instanceId: "recovery-probe",
      configRoot: root,
    };
    initializeConfiguration(context);
    const linkedConfig = createRequire(
      path.join(repoRoot, "app-server/package.json"),
    ).resolve("@runweave/config-node");
    (await import(pathToFileURL(linkedConfig).href)).initializeConfiguration(
      context,
    );
    await import(
      pathToFileURL(path.join(repoRoot, "app-server/src/index.ts")).href
    );
    return;
  }
  const originalWrite = fs.writeFile.bind(fs);
  const originalOpen = fs.open.bind(fs);
  const originalRename = fs.rename.bind(fs);
  let armed = false;
  let injected = false;
  async function inject(data, write) {
    injected = true;
    if (mode === "truncate-crash") {
      await write("");
      console.log(JSON.stringify({ injected: true }));
      process.exit(73);
    }
    const boundary = data.indexOf("\n") + 1;
    await write(data.slice(0, boundary + 20));
    console.log(JSON.stringify({ mode, stage, injected: true }));
    throw new Error("injected_partial_write_ENOSPC");
  }
  const target = (file) =>
    String(file) === log || String(file).startsWith(log + ".");
  fs.writeFile = async (file, data, options) => {
    if (
      armed &&
      !injected &&
      target(file) &&
      options?.flag !== "a" &&
      (mode === "truncate-crash" || mode === "partial-fail")
    )
      return inject(String(data), (value) =>
        originalWrite(file, value, options),
      );
    return originalWrite(file, data, options);
  };
  fs.open = async (file, flags, permissions) => {
    const handle = await originalOpen(file, flags, permissions);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (data, options) => {
      if (
        armed &&
        !injected &&
        target(file) &&
        (mode === "truncate-crash" || mode === "partial-fail")
      )
        return inject(String(data), (value) => write(value, options));
      return write(data, options);
    };
    return handle;
  };
  fs.rename = async (from, to) => {
    if (armed && target(to) && mode === "before-rename") {
      console.log(JSON.stringify({ injected: true }));
      process.exit(74);
    }
    const result = await originalRename(from, to);
    if (armed && target(to) && mode === "after-rename") {
      console.log(JSON.stringify({ injected: true }));
      process.exit(75);
    }
    return result;
  };
  syncBuiltinESMExports();
  const store = new AppServerEventStore(log, { pruneIntervalMs: 0 });
  if (stage === "runtime") {
    const realNow = Date.now;
    Date.now = () => realNow() - 2 * 86400000;
    await store.initialize();
    Date.now = realNow;
    armed = true;
    const appends = Array.from({ length: 20 }, (_, index) =>
      store.append({
        kind: "diagnostic.created",
        source: { app: "cli", instanceId: "fixture", pid: 123 },
        payload: { concurrent: index },
      }),
    );
    const results = await Promise.allSettled(appends);
    await fs.writeFile(
      path.join(root, "appends.json"),
      JSON.stringify(results),
    );
    console.log(
      JSON.stringify({
        mode,
        stage,
        successful: results.filter((result) => result.status === "fulfilled")
          .length,
        failed: results.filter((result) => result.status === "rejected").length,
        injected,
      }),
    );
  } else {
    armed = true;
    try {
      await store.initialize();
    } catch (error) {
      console.log(String(error));
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
