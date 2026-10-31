import {
  configuration,
  resolveConfigurationContext,
  configurationPath,
  withConfigurationArguments,
} from "@runweave/config-node";
import { installAppServerRuntimeRelease } from "@runweave/config-node/app-server/runtime-release";
import type { ServerReleaseManifest } from "@runweave/shared/server-management";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

type Component = "backend" | "app-server";
interface RuntimeContext {
  home: string;
  release: string;
  manifest: ServerReleaseManifest;
}
const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8")) as T;
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
}
function processStart(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
}
async function waitForAppServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const lock = readJson<{ port: number }>(
        path.join(
          configurationPath("appServer.stateDirectory", "app-server"),
          "app-server.lock.json",
        ),
      );
      const response = await fetch(`http://127.0.0.1:${lock.port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      /* App Server is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("App Server did not become healthy");
}

export async function runComponent(
  ctx: RuntimeContext,
  name: Component,
): Promise<void> {
  // A server launched inside another Runweave terminal must discover its own singleton,
  // not reuse the parent's hook connection or Browser endpoint.
  delete process.env.RUNWEAVE_APP_SERVER_URL;
  delete process.env.RUNWEAVE_APP_SERVER_TOKEN;
  delete process.env.RUNWEAVE_HOOK_TOKEN;
  delete process.env.RUNWEAVE_HOOK_DEBUG_LOG;
  delete process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
  const fd = createRequire(__filename)(
    "fs-native-extensions",
  ) as typeof import("fs-native-extensions");
  const fs = await import("node:fs");
  const lock = fs.openSync(path.join(ctx.home, `${name}.lock`), "a+", 0o600);
  if (!fd.tryLock(lock)) {
    fs.closeSync(lock);
    throw new Error(`${name} already running`);
  }
  process.on("exit", () => fs.closeSync(lock));
  writeJson(path.join(ctx.home, `${name}.json`), {
    pid: process.pid,
    startedAt: processStart(process.pid),
    version: ctx.manifest.version,
    release: ctx.release,
  });
  const nativeRequire = createRequire(
    path.join(ctx.release, "backend/index.cjs"),
  );
  if (name === "backend") {
    const backend = path.join(ctx.release, "backend");
    process.env.FRONTEND_DIST_DIR = path.join(ctx.release, "frontend/dist");
    for (const [key, file] of Object.entries({
      RUNWEAVE_ACTIVITY_WORKER_ENTRY: "activity-sqlite-worker.cjs",
      RUNWEAVE_EVOLUTION_WORKER_ENTRY: "evolution-sqlite-worker.cjs",
      RUNWEAVE_SCHEDULED_TASKS_WORKER_ENTRY:
        "scheduled-tasks-sqlite-worker.cjs",
    }))
      process.env[key] = path.join(backend, file);
    process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR = path.join(
      backend,
      "node_modules/better-sqlite3",
    );
    process.env.RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING = path.join(
      process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR,
      "prebuilds",
      ctx.manifest.sqlitePrebuild,
    );
    process.env.RUNWEAVE_NODE_PTY_DIR = path.join(
      backend,
      "node_modules/node-pty",
    );
    process.env.RUNWEAVE_RUNTIME_RELEASE_ID = ctx.manifest.version;
    process.env.RUNWEAVE_CLI_BIN = path.join(ctx.home, "rw");
    nativeRequire(path.join(backend, "index.cjs"));
  } else {
    const entry = path.join(ctx.release, "app-server/index.cjs");
    const appServer = nativeRequire(entry) as {
      startAppServer(prepareRuntime: () => void): Promise<void>;
    };
    await appServer.startAppServer(() => {
      const runtime = installAppServerRuntimeRelease({
        entry,
        releaseId: `server-${ctx.manifest.version}`,
      });
      process.env.RUNWEAVE_APP_SERVER_ENTRY = runtime.entry;
      process.env.RUNWEAVE_APP_SERVER_RELEASE_ID = runtime.releaseId;
      process.env.RUNWEAVE_APP_SERVER_RUNTIME_ROOT = runtime.runtimeRoot ?? "";
    });
  }
}

export async function runServerRuntime(args: string[]): Promise<void> {
  await withConfigurationArguments(args, async () => {
    const context = resolveConfigurationContext();
    if (context.instanceId !== "stable")
      throw new Error("Standalone Server requires the stable instance");
    const release = path.resolve(__dirname, "..");
    const manifest = readJson<ServerReleaseManifest>(
      path.join(release, "server-manifest.json"),
    );
    if (
      manifest.managementApiVersion !== 1 ||
      manifest.nodeModuleAbi !== process.versions.modules ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch
    )
      throw new Error(
        "Server runtime/API does not match this platform or Node ABI",
      );
    if (process.versions.node.split(".")[0] !== "22")
      throw new Error("Server requires Node 22");
    if (
      process.platform === "linux" &&
      !(
        process.report.getReport() as {
          header: { glibcVersionRuntime?: string };
        }
      ).header.glibcVersionRuntime
    )
      throw new Error("Linux glibc is required");
    const [command, component] = args;
    if (command === "inspect") {
      const requireNative = createRequire(
        path.join(release, "backend/index.cjs"),
      );
      const Database = requireNative("better-sqlite3") as new (
        file: string,
      ) => { prepare(sql: string): { get(): unknown }; close(): void };
      const database = new Database(":memory:");
      try {
        database.prepare("SELECT 1").get();
      } finally {
        database.close();
      }
      requireNative("node-pty");
      return;
    }
    if (
      command !== "component" ||
      (component !== "backend" && component !== "app-server")
    )
      throw new Error(
        "Server is managed with rw server; internal entry expects component <backend|app-server>",
      );
    if (component === "backend") {
      if (configuration().get("terminal.tmux.shutdownPolicy") === "cleanup")
        throw new Error("Standalone Server requires tmux preserve");
      await waitForAppServer();
    }
    const home = path.join(context.configRoot, "server");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    await runComponent({ home, release, manifest }, component);
  });
}

if (require.main === module)
  void runServerRuntime(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
