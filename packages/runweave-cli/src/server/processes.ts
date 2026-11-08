import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { ensureHost } from "@runweave/pty-host/lifecycle";
import { updateServer } from "./update.js";
import { randomUUID, createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { chmodSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { configuration, CONFIGURATION_COMPATIBILITY, resolveActiveServerRelease } from "@runweave/config-node";
import {
  controlSocket,
  identity,
  processStart,
  readJson,
  settings,
  waitHealthy,
  writeJson,
  withManagementLock,
  type Component,
  type ServerContext,
} from "./context.js";

function spawnComponent(ctx: ServerContext, name: Component): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      path.join(ctx.release, "server/index.cjs"),
      "component",
      name,
      ...ctx.configArgs,
    ],
    { stdio: process.platform === "win32" ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "inherit", "inherit"], env: process.env },
  );
  child.on("error", (error) => process.stderr.write(`${error.message}\n`));
  return child;
}

export async function foreground(ctx: ServerContext): Promise<void> {
  if (
    identity(ctx, "backend") ||
    identity(ctx, "app-server") ||
    identity(ctx, "foreground")
  )
    throw new Error("SERVER_ALREADY_RUNNING");
  const socket = controlSocket(ctx);
  if (process.platform !== "win32") rmSync(socket, { force: true });
  writeJson(path.join(ctx.home, "foreground.json"), {
    configuration: CONFIGURATION_COMPATIBILITY,
    pid: process.pid,
    startedAt: processStart(process.pid),
    version: ctx.manifest.version,
    release: ctx.release,
  });
  const jobs = path.join(ctx.home, "updates");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(jobs).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const file = path.join(jobs, name);
    const job = readJson<UpdateJob>(file);
    if (job.state === "accepted") writeJson(file, { ...job, state: "interrupted", error: "SERVER_UPDATE_INTERRUPTED: inspect update.json and the active release before retrying" });
  }
  let children: ChildProcess[] = [];
  let stopping = false;
  let intentional = false;
  let busy = false;
  let settle!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Rejections can happen while the first health wait is still in progress.
  void done.catch(() => {});
  const stop = async () => {
    intentional = true;
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Component shutdown timed out")),
          60_000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        if (process.platform === "win32" && child.connected) child.send("runweave:shutdown", (error) => { if (error) child.kill(); });
        else child.kill("SIGTERM");
      });
    }
    children = [];
  };
  const start = async (release = ctx.release) => {
    release = realpathSync(release);
    const next = {
      ...ctx,
      release,
      manifest: readJson<typeof ctx.manifest>(
        path.join(release, "server-manifest.json"),
      ),
    };
    if (process.platform === "win32") {
      if (next.manifest.ptyHost?.protocolVersion !== 1) throw new Error("HOST_PROTOCOL_INCOMPATIBLE");
      await ensureHost(ctx.context, release);
    }
    intentional = false;
    for (const name of ["app-server", "backend"] as const) {
      const child = spawnComponent(next, name);
      children.push(child);
      child.on("exit", (code, signal) => {
        if (!intentional && !stopping)
          fail(new Error(`${name} exited (${code ?? signal})`));
      });
      await waitHealthy(next, name);
    }
    writeJson(path.join(ctx.home, "foreground.json"), {
      configuration: CONFIGURATION_COMPATIBILITY, pid: process.pid, startedAt: processStart(process.pid),
      version: next.manifest.version, release,
    });
  };
  const shutdown = () => {
    stopping = true;
    void stop().then(settle, fail);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const server = createServer((client) => {
    client.setTimeout(180_000, () => client.destroy());
    let source = "";
    client.on("data", (bytes) => {
      source += bytes.toString();
      if (source.length > 2048) {
        client.destroy();
        return;
      }
      if (!source.includes("\n")) return;
      client.pause();
      void (async () => {
        if (busy) throw new Error("SERVER_BUSY");
        const command = JSON.parse(source.trim()) as {
          action: string;
          token: string;
          requestId?: string;
          update?: UpdateRequest;
        };
        if (
          command.token !==
          readFileSync(path.join(ctx.home, "management-token"), "utf8").trim()
        )
          throw new Error("Forbidden");
        if (command.action === "update") {
          const requestId = command.requestId;
          if (!requestId || !/^[a-f0-9-]{36}$/.test(requestId) || !command.update) throw new Error("Invalid update request");
          const request = command.update;
          if (typeof request.force !== "boolean" || !["latest", "next"].includes(request.channel) ||
            request.version !== undefined && !/^\d+\.\d+\.\d+$/.test(request.version) ||
            request.sourcePackage !== undefined && (!path.isAbsolute(request.sourcePackage) || request.sourcePackage.length > 1024)) throw new Error("Invalid update request");
          const file = path.join(jobs, `${requestId}.json`);
          const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
          if (existsSync(file)) {
            if (readJson<UpdateJob>(file).digest !== digest) throw new Error("SERVER_UPDATE_CONFLICT");
            client.end(JSON.stringify({ accepted: true, requestId, receipt: file }) + "\n");
            return;
          }
          const job: UpdateJob = { requestId, digest, request, state: "accepted" };
          writeJson(file, job);
          busy = true;
          client.end(JSON.stringify({ accepted: true, requestId, receipt: file }) + "\n");
          void withManagementLock(ctx, async () => {
            const release = fsRealCurrent(ctx);
            const active = { ...ctx, release, manifest: readJson<typeof ctx.manifest>(path.join(release, "server-manifest.json")) };
            await updateServer(active, request.version, request.force, request.sourcePackage, false,
              { transactionId: requestId, controls: { pause: stop, restart: () => start(fsRealCurrent(ctx)) } }, request.channel);
            writeJson(file, { ...job, state: "complete" });
          }).catch(error => { writeJson(file, { ...job, state: "failed", error: (error as Error).message }); })
            .finally(() => { busy = false; });
          return;
        }
        if (!["stop", "restart", "pause"].includes(command.action))
          throw new Error("Invalid action");
        busy = true;
        try {
          await stop();
          if (command.action === "restart") await start(fsRealCurrent(ctx));
          client.end('{"ok":true}\n');
          if (command.action === "stop") {
            stopping = true;
            settle();
          }
        } finally {
          busy = false;
        }
      })().catch((error) =>
        client.end(JSON.stringify({ error: (error as Error).message }) + "\n"),
      );
    });
    client.on("error", () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        if (process.platform !== "win32") chmodSync(socket, 0o600);
        resolve();
      });
    });
    await start();
    process.stderr.write(
      `Runweave ${ctx.manifest.version} ready at ${settings(ctx).url}\n`,
    );
    await done;
  } finally {
    stopping = true;
    await stop();
    server.close();
    if (process.platform !== "win32") rmSync(socket, { force: true });
    rmSync(path.join(ctx.home, "foreground.json"), { force: true });
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
function fsRealCurrent(ctx: ServerContext): string {
  // Resolve again after a successful update has activated the new release.
  const release = resolveActiveServerRelease(ctx.home);
  if (!release) throw new Error("SERVER_NOT_INSTALLED");
  return release;
}
export { foregroundControl } from "./control.js";

export function checkTmuxPolicy(): void {
  const policy = configuration().get("terminal.tmux.shutdownPolicy");
  if (policy === "cleanup")
    throw new Error(
      "Standalone server requires terminal.tmux.shutdownPolicy=preserve",
    );
}

export interface UpdateRequest { version?: string; sourcePackage?: string; force: boolean; channel: "latest" | "next" }
interface UpdateJob { requestId: string; digest: string; request: UpdateRequest; state: "accepted" | "complete" | "failed" | "interrupted"; error?: string }

/** Submission is durable before acknowledgement. A caller disconnect cannot cancel execution. */
export async function submitForegroundUpdate(ctx: ServerContext, request: UpdateRequest, requestId: string = randomUUID()): Promise<unknown> {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid --request-id");
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(controlSocket(ctx));
    let source = "";
    client.setTimeout(10_000, () => client.destroy(new Error("SERVER_UPDATE_ACCEPTANCE_UNCERTAIN: inspect the receipt using the same request ID")));
    client.on("error", reject);
    client.on("connect", () => client.write(JSON.stringify({ action: "update", requestId, update: request,
      token: readFileSync(path.join(ctx.home, "management-token"), "utf8").trim() }) + "\n"));
    client.on("data", chunk => { source += chunk.toString(); if (source.length > 8192) client.destroy(new Error("Invalid control response")); });
    client.on("end", () => { try { const value = JSON.parse(source); if (!value.accepted) throw new Error(value.error ?? "SERVER_UPDATE_NOT_ACCEPTED"); resolve(); } catch (error) { reject(error); } });
  });
  const receipt = path.join(ctx.home, "updates", `${requestId}.json`);
  process.stderr.write(`Update accepted: ${requestId}; receipt: ${receipt}\n`);
  while (true) {
    const job = readJson<UpdateJob>(receipt);
    if (job.state === "complete") return { requestId, state: job.state, receipt };
    if (job.state !== "accepted") throw new Error(job.error ?? "SERVER_UPDATE_FAILED");
    if (!identity(ctx, "foreground")) throw new Error("SERVER_UPDATE_OWNER_UNAVAILABLE: inspect the receipt before retrying");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
