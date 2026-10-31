import { createServer, createConnection } from "node:net";
import { chmodSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { configuration } from "@runweave/config-node";
import {
  controlSocket,
  identity,
  processStart,
  readJson,
  settings,
  waitHealthy,
  writeJson,
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
    { stdio: ["ignore", "inherit", "inherit"], env: process.env },
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
  rmSync(socket, { force: true });
  writeJson(path.join(ctx.home, "foreground.json"), {
    pid: process.pid,
    startedAt: processStart(process.pid),
    version: ctx.manifest.version,
    release: ctx.release,
  });
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
      child.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Component shutdown timed out")),
          60_000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
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
        };
        if (
          command.token !==
          readFileSync(path.join(ctx.home, "management-token"), "utf8").trim()
        )
          throw new Error("Forbidden");
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
        chmodSync(socket, 0o600);
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
    rmSync(socket, { force: true });
    rmSync(path.join(ctx.home, "foreground.json"), { force: true });
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
function fsRealCurrent(ctx: ServerContext): string {
  // Resolve again after a successful update has activated the new release.
  return path.join(ctx.home, "current");
}
export async function foregroundControl(
  ctx: ServerContext,
  action: "stop" | "restart" | "pause",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(controlSocket(ctx));
    let data = "";
    client.setTimeout(130_000, () =>
      client.destroy(new Error("Foreground control timed out")),
    );
    client.on("error", reject);
    client.on("connect", () =>
      client.write(
        JSON.stringify({
          action,
          token: readFileSync(
            path.join(ctx.home, "management-token"),
            "utf8",
          ).trim(),
        }) + "\n",
      ),
    );
    client.on("data", (chunk) => {
      data += chunk.toString();
    });
    client.on("end", () => {
      try {
        const result = JSON.parse(data) as { error?: string };
        if (result.error) reject(new Error(result.error));
        else resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function checkTmuxPolicy(): void {
  const policy = configuration().get("terminal.tmux.shutdownPolicy");
  if (policy === "cleanup")
    throw new Error(
      "Standalone server requires terminal.tmux.shutdownPolicy=preserve",
    );
}
