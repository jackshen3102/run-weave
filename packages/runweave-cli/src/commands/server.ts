import type { RuntimeNodeStatusSnapshot } from "@runweave/shared/runtime-status";
import {
  ConfigurationStore,
  assertNewStableInstallation,
  prepareInitialConfiguration,
  readInitialAuthFile,
  setConfigurationValue,
} from "@runweave/config-node";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { getStringOption, parseArgs } from "../args.js";
import {
  identity,
  readJson,
  requestJson,
  serverContext,
  settings,
  verifyRelease,
  withManagementLock,
  type ServerContext,
} from "../server/context.js";
import {
  checkTmuxPolicy,
  foreground,
  foregroundControl,
} from "../server/processes.js";
import {
  registered,
  renderService,
  serviceInstall,
  serviceStart,
  serviceStatus,
  serviceStop,
  serviceUninstall,
} from "../server/services.js";
import { ServerNotInstalledError } from "../server/installation.js";
import { readCliVersion } from "../version.js";
import { protectedRestart, updateServer } from "../server/update.js";

function token(ctx: ServerContext): void {
  const file = path.join(ctx.home, "management-token");
  if (!existsSync(file))
    writeFileSync(file, randomBytes(32).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    path.join(ctx.home, "rw"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} "$@"\n`,
    { mode: 0o700 },
  );
}
function inspect(ctx: ServerContext): void {
  verifyRelease(ctx.release);
  execFileSync(
    process.execPath,
    [path.join(ctx.release, "server/index.cjs"), "inspect", ...ctx.configArgs],
    { timeout: 15_000, stdio: "pipe" },
  );
}
function binary(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(directory, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      /* next PATH entry */
    }
  }
  return null;
}
async function status(ctx: ServerContext) {
  const backend = identity(ctx, "backend"),
    appServer = identity(ctx, "app-server");
  const config = existsSync(path.join(ctx.context.configRoot, "settings.yaml"))
    ? settings(ctx)
    : null;
  let backendHealth: unknown = null,
    appHealth: unknown = null;
  if (backend && config)
    backendHealth = await requestJson(config.localUrl + "/health").catch(
      () => null,
    );
  if (appServer && config) {
    try {
      const lock = readJson<{ port: number }>(
        path.join(config.appState, "app-server.lock.json"),
      );
      appHealth = await requestJson(`http://127.0.0.1:${lock.port}/healthz`);
    } catch {
      /* status must distinguish an owner from a healthy endpoint */
    }
  }
  let runtimeIssues: { id: string; summary: string }[] = [];
  if (backend && config) {
    try {
      const report = (await requestJson(
        config.localUrl + "/api/server/status",
        {
          headers: {
            "x-runweave-server-token": readFileSync(
              path.join(ctx.home, "management-token"),
              "utf8",
            ).trim(),
            "x-runweave-server-owner": randomUUID(),
          },
        },
      )) as RuntimeNodeStatusSnapshot;
      runtimeIssues = report.reports
        .flatMap((entry) => entry.items)
        .filter((item) => item.state === "unhealthy")
        .map((item) => ({ id: item.id, summary: item.summary }));
    } catch {
      runtimeIssues = [
        {
          id: "server.status",
          summary: "Local runtime diagnostics unavailable",
        },
      ];
    }
  }
  const active = readJson<typeof ctx.manifest>(
    path.join(
      realpathSync(path.join(ctx.home, "current")),
      "server-manifest.json",
    ),
  );
  const installed = ctx.installation.packageRoot;
  const lastUpdate = existsSync(path.join(ctx.home, "update.json"))
    ? readJson<{ phase: string; error?: string }>(
        path.join(ctx.home, "update.json"),
      )
    : null;
  return {
    schemaVersion: 1,
    mode: registered(ctx)
      ? "service"
      : identity(ctx, "foreground")
        ? "foreground"
        : "stopped",
    healthy: !!backendHealth && !!appHealth && runtimeIssues.length === 0,
    runtimeIssues,
    cliVersion: readCliVersion().version,
    installedVersion: existsSync(path.join(installed, "package.json"))
      ? readJson<{ version: string }>(path.join(installed, "package.json"))
          .version
      : null,
    activeVersion: active.version,
    runningVersion: backend?.version ?? null,
    sourceRevision: active.sourceRevision,
    backend: { ...backend, health: backendHealth },
    appServer: { ...appServer, health: appHealth },
    address: config?.url ?? null,
    configDirectory: ctx.context.configRoot,
    dataDirectory: config?.profile ?? null,
    service: serviceStatus(ctx),
    lastUpdate,
    lastError: lastUpdate?.phase === "failed" ? lastUpdate.error : null,
  };
}

export async function runServerCommand(
  command: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  },
): Promise<void> {
  const parsed = parseArgs(
    args,
    new Set(["json", "force", "follow", "dry-run"]),
  );
  const allowed = new Set([
    "json",
    "force",
    "follow",
    "dry-run",
    "instance",
    "config-dir",
    "auth-file",
    "host",
    "port",
    "version",
    "server-package",
  ]);
  for (const key of Object.keys(parsed.options))
    if (!allowed.has(key)) throw new Error(`Unknown server option: --${key}`);
  const output = (value: unknown) =>
    io.stdout.write(JSON.stringify(value, null, 2) + "\n");
  let ctx: ServerContext;
  try {
    ctx = serverContext(args);
  } catch (error) {
    if (
      error instanceof ServerNotInstalledError &&
      (command === "status" || command === "doctor")
    ) {
      output({
        schemaVersion: 1,
        installed: false,
        healthy: false,
        cliVersion: readCliVersion().version,
        guidance: error.message,
      });
      return;
    }
    throw error;
  }
  const selectedPackage = getStringOption(parsed.options, "server-package");
  if (
    command !== "update" &&
    selectedPackage &&
    realpathSync(selectedPackage) !== ctx.installation.packageRoot
  )
    throw new Error(
      "Use rw server update --server-package <path> to change an existing Server installation",
    );
  if (command === "inspect") {
    inspect(ctx);
    output({ valid: true, version: ctx.manifest.version });
    return;
  }
  if (command === "status") {
    output(await status(ctx));
    return;
  }
  if (command === "doctor") {
    let runtimeError: string | null = null;
    try {
      inspect(ctx);
    } catch (error) {
      runtimeError = (error as Error).message;
    }
    const tools = Object.fromEntries(
      ["git", "tmux", "codex", "pi"].map((name) => [
        name,
        { installed: !!binary(name), path: binary(name) },
      ]),
    );
    let codexAuthenticated = false;
    if (tools.codex?.installed) {
      try {
        execFileSync(binary("codex")!, ["login", "status"], {
          timeout: 5000,
          stdio: "ignore",
        });
        codexAuthenticated = true;
      } catch {
        /* not authenticated */
      }
    }
    output({
      runtimeReady: !runtimeError,
      runtimeError,
      initialized: existsSync(
        path.join(ctx.context.configRoot, "settings.yaml"),
      ),
      terminalReady: !runtimeError && tools.tmux?.installed,
      tools,
      agents: {
        codex: { authenticated: codexAuthenticated },
        pi: { authentication: "not checked; configure a provider before use" },
      },
      guidance:
        "Install missing Git/tmux with your system package manager; install and authenticate Agent tools separately.",
    });
    if (runtimeError) throw new Error(runtimeError);
    return;
  }
  if (command === "init") {
    await withManagementLock(ctx, async () => {
      const store = new ConfigurationStore(ctx.context);
      if (existsSync(store.file)) {
        store.read();
        token(ctx);
        output({ initialized: true, changed: false, file: store.file });
        return;
      }
      assertNewStableInstallation(ctx.context);
      const authFile = getStringOption(parsed.options, "auth-file");
      let auth: { username: string; password: string };
      if (authFile) auth = readInitialAuthFile(authFile);
      else {
        if (!process.stdin.isTTY || !process.stderr.isTTY)
          throw new Error(
            "Non-interactive init requires --auth-file <absolute private JSON file>",
          );
        const readline = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          auth = {
            username:
              (await readline.question("Login username [runweave]: ")).trim() ||
              "runweave",
            password: randomBytes(24).toString("base64url"),
          };
        } finally {
          readline.close();
        }
        io.stderr.write(
          `Generated login password (save it now): ${auth.password}\n`,
        );
      }
      const value = prepareInitialConfiguration(ctx.context, auth);
      const host = getStringOption(parsed.options, "host") ?? "127.0.0.1";
      const port = Number(getStringOption(parsed.options, "port") ?? "5001");
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Invalid --port");
      setConfigurationValue(value, "backend.server.host", host);
      setConfigurationValue(value, "backend.server.port", port);
      setConfigurationValue(value, "terminal.tmux.shutdownPolicy", "preserve");
      setConfigurationValue(value, "storage.activityKeyStorage", "file");
      store.initialize(value);
      token(ctx);
      output({
        initialized: true,
        changed: true,
        file: store.file,
        address: settings(ctx).url,
      });
    });
    return;
  }
  if (command === "logs") {
    const files = ["app-server", "backend"]
      .map((name) => path.join(ctx.home, `${name}.log`))
      .filter(existsSync);
    if (!files.length) {
      output({
        logs: [],
        guidance: "Foreground logs are written to its terminal",
      });
      return;
    }
    if (parsed.options.follow) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("tail", ["-n", "100", "-f", ...files], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
    } else
      for (const file of files)
        io.stdout.write(
          readFileSync(file, "utf8").split("\n").slice(-100).join("\n") + "\n",
        );
    return;
  }
  if (command === "start" && !registered(ctx)) {
    inspect(ctx);
    checkTmuxPolicy();
    token(ctx);
    // The foreground owner holds a distinct lifetime lock; management commands remain available.
    const { tryLock } = createRequire(__filename)(
      "fs-native-extensions",
    ) as typeof import("fs-native-extensions");
    const fs = await import("node:fs");
    const fd = fs.openSync(path.join(ctx.home, "foreground.lock"), "a+", 0o600);
    try {
      if (!tryLock(fd)) throw new Error("SERVER_ALREADY_RUNNING");
      await foreground(ctx);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  await withManagementLock(ctx, async () => {
    const force = parsed.options.force === true;
    if (command === "start") {
      inspect(ctx);
      await serviceStart(ctx);
      output(await status(ctx));
      return;
    }
    if (command === "stop" || command === "restart") {
      const action = async () => {
        if (registered(ctx)) {
          await serviceStop(ctx);
          if (command === "restart") await serviceStart(ctx);
        } else if (identity(ctx, "foreground"))
          await foregroundControl(ctx, command);
        else if (identity(ctx, "backend") || identity(ctx, "app-server"))
          throw new Error(
            "Components lack their service/foreground owner; inspect status before recovery",
          );
      };
      if (command === "restart") await protectedRestart(ctx, force, action);
      else await action();
      output(await status(ctx));
      return;
    }
    if (command === "update") {
      await updateServer(
        ctx,
        getStringOption(parsed.options, "version"),
        force,
        getStringOption(parsed.options, "server-package"),
      );
      output(await status(serverContext(args)));
      return;
    }
    if (command === "service") {
      const action = parsed.positionals[0];
      if (action === "install") {
        inspect(ctx);
        checkTmuxPolicy();
        token(ctx);
        if (parsed.options["dry-run"]) {
          output({
            backend: renderService(ctx, "backend"),
            appServer: renderService(ctx, "app-server"),
          });
          return;
        }
        if (identity(ctx, "foreground"))
          throw new Error(
            "Stop the foreground session before installing system services",
          );
        await serviceInstall(ctx);
      } else if (action === "uninstall") await serviceUninstall(ctx);
      else
        throw new Error(
          "Usage: rw server service <install|uninstall> [--dry-run]",
        );
      output(await status(ctx));
      return;
    }
    throw new Error(
      "Usage: rw server <init|doctor|start|stop|restart|status|logs|update|service> [options]",
    );
  });
}
