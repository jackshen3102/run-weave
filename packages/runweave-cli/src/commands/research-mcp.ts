import { acquireConfigurationOwner, configurationArguments, readResearchMcpInstallation, researchMcpHome, resolveConfigurationContext, writeResearchMcpInstallation } from "@runweave/config-node";
import type { ResearchMcpInstallation } from "@runweave/shared/research-mcp";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs, getStringOption, requireStringOption } from "../args.js";
import { CliError } from "../errors.js";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function jobs() {
  const identity = createHash("sha256").update(researchMcpHome()).digest("hex").slice(0, 12);
  return ["mcp", "tunnel"].map((part) => {
    const label = `com.runweave.research-${part}.${identity}`;
    return { label, file: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`) };
  });
}

function launchctl(args: string[], allowFailure = false): void {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) throw new Error(`launchctl ${args[0]} failed: ${result.stderr.trim()}`);
}

async function unload(): Promise<void> {
  for (const job of jobs()) launchctl(["bootout", `gui/${process.getuid!()}/${job.label}`], true);
  const deadline = Date.now() + 10_000;
  while (jobs().some((_, index) => jobRunning(index)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  if (jobs().some((_, index) => jobRunning(index))) throw new Error("launchd jobs are still stopping; refusing to replace them");
}

function jobRunning(index: number): boolean {
  return spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${jobs()[index]!.label}`], { stdio: "ignore" }).status === 0;
}

async function waitPortFree(port: number): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { await assertPortFree(port); return; } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await assertPortFree(port);
}

function writeJobs(value: ResearchMcpInstallation): void {
  const context = resolveConfigurationContext();
  const definitions = [
    [value.node, value.entry, ...configurationArguments(context), "--cwd", value.cwd, "--port", String(value.port)],
    value.tunnel ? [value.node, value.entry, ...configurationArguments(context), "--tunnel-run"] : null,
  ];
  mkdirSync(path.join(researchMcpHome(), "logs"), { recursive: true, mode: 0o700 });
  jobs().forEach((job, i) => {
    const args = definitions[i];
    if (!args) { rmSync(job.file, { force: true }); return; }
    mkdirSync(path.dirname(job.file), { recursive: true });
    const log = path.join(researchMcpHome(), "logs", i === 0 ? "mcp" : "tunnel");
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${xml(job.label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(os.homedir())}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(`${log}.out.log`)}</string><key>StandardErrorPath</key><string>${xml(`${log}.err.log`)}</string>
</dict></plist>`;
    writeFileSync(job.file, content, { mode: 0o600 });
  });
}

async function load(value: ResearchMcpInstallation): Promise<void> {
  writeJobs(value);
  for (const [index, job] of jobs().entries()) if (existsSync(job.file) && !jobRunning(index)) {
    for (let attempt = 0; ; attempt++) {
      try { launchctl(["bootstrap", `gui/${process.getuid!()}`, job.file]); break; }
      catch (error) {
        if (attempt >= 24) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

async function health(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch { return null; }
}

async function waitHealthy(value: ResearchMcpInstallation): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await health(value.port);
    if (result?.service === "runweave-research-mcp" && result.instance === value.instanceId && result.releaseId === value.releaseId && result.sourceRevision === value.sourceRevision) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Research MCP did not start; inspect research-mcp/logs/mcp.err.log");
}

async function assertPortFree(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error(`Port ${port} is occupied; refusing to stop an unowned service`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

async function preflight(value: ResearchMcpInstallation): Promise<void> {
  const listener = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return reject(new Error("Missing preflight port"));
      listener.close(() => resolve(address.port));
    });
  });
  const child = spawn(value.node, [value.entry, ...configurationArguments(resolveConfigurationContext()), "--cwd", value.cwd, "--port", String(port)], {
    stdio: "ignore", env: { PATH: process.env.PATH, HOME: os.homedir() },
  });
  let failed = false;
  child.once("error", () => { failed = true; });
  try {
    await waitHealthy({ ...value, port });
    if (failed) throw new Error("Candidate runtime could not start");
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "rw-install", version: "1" } } }),
      signal: AbortSignal.timeout(3000),
    });
    const result = await response.json() as { result?: { serverInfo?: { name?: string } } };
    if (!response.ok || result.result?.serverInfo?.name !== "runweave-research") throw new Error("Candidate MCP handshake failed");
  } finally {
    if (child.exitCode === null && !failed) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
}

function checkTunnel(value: ResearchMcpInstallation): boolean {
  if (!value.tunnel) return false;
  const result = spawnSync(value.tunnel.executable, ["runtimes", "status", value.tunnel.profile, "--json"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Cannot inspect existing tunnel runtime");
  const status = JSON.parse(result.stdout) as { process_running?: boolean; process?: { target_value?: string; profile_path?: string } };
  if (status.process_running && (status.process?.target_value !== `http://127.0.0.1:${value.port}/mcp` || status.process.profile_path !== path.join(value.tunnel.profileDir, `${value.tunnel.profile}.yaml`))) {
    throw new Error("Existing tunnel belongs to another target/profile; refusing takeover");
  }
  return status.process_running === true;
}

export async function runResearchMcpCommand(subcommand: string | undefined, args: string[], io: { stdout: Pick<NodeJS.WriteStream, "write"> }): Promise<void> {
  if (subcommand === "status") return runCommand(subcommand, args, io);
  const owner = acquireConfigurationOwner(resolveConfigurationContext({ requireExplicit: true }), "research-mcp-management");
  try { await runCommand(subcommand, args, io); } finally { owner.release(); }
}

async function runCommand(subcommand: string | undefined, args: string[], io: { stdout: Pick<NodeJS.WriteStream, "write"> }): Promise<void> {
  const context = resolveConfigurationContext({ requireExplicit: true });
  const { options } = parseArgs(args, new Set(["json", "adopt-tunnel"]));
  if (process.platform !== "darwin") throw new CliError("Research MCP service management currently requires macOS", 2);
  const previous = readResearchMcpInstallation();
  const output = (value: object) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (subcommand === "status") {
    let runtimeStatus: unknown = null;
    if (previous) {
      try {
        const response = await fetch(`http://127.0.0.1:${previous.port}/runtime-status`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (response.ok) runtimeStatus = await response.json();
      } catch { /* Separate the installed/enabled intent from live availability. */ }
    }
    output({ installed: !!previous, enabled: previous?.enabled ?? false, installation: previous, health: previous ? await health(previous.port) : null, jobs: jobs().map((job, index) => ({ label: job.label, loaded: jobRunning(index) })), runtimeStatus });
    return;
  }
  if (subcommand === "stop" || subcommand === "uninstall") {
    if (previous) writeResearchMcpInstallation({ ...previous, enabled: false });
    await unload();
    for (const job of jobs()) rmSync(job.file, { force: true });
    if (subcommand === "uninstall") rmSync(path.join(researchMcpHome(), "installation.json"), { force: true });
    output({ stopped: true, uninstalled: subcommand === "uninstall" });
    return;
  }
  if (subcommand === "start") {
    if (!previous) throw new CliError("Install research MCP first", 2);
    const value = { ...previous, enabled: true };
    if (jobRunning(0)) {
      await waitHealthy(value);
      if (value.tunnel && !jobRunning(1) && checkTunnel(value)) throw new Error("Unmanaged tunnel is running; refusing duplicate startup");
      await load(value);
      output({ started: true, alreadyRunning: true, health: await health(value.port) }); return;
    }
    await assertPortFree(value.port);
    await unload();
    writeResearchMcpInstallation(value);
    await load(value);
    await waitHealthy(value);
    output({ started: true, health: await health(value.port) });
    return;
  }
  if (subcommand !== "install") throw new CliError("Usage: rw research-mcp <install|start|stop|status|uninstall> --instance <id> [--entry <bundle> --cwd <directory> --tunnel-profile <profile> --tunnel-executable <path> --adopt-tunnel]", 2);
  const sourceEntry = path.resolve(requireStringOption(options, "entry"));
  const metadata = JSON.parse(readFileSync(path.join(path.dirname(sourceEntry), "release.json"), "utf8")) as { sourceRevision: string; releaseId: string };
  if (!/^[a-zA-Z0-9._+-]+$/.test(metadata.releaseId) || typeof metadata.sourceRevision !== "string") throw new Error("Invalid release metadata");
  const port = Number(getStringOption(options, "port") ?? previous?.port ?? 5099);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("Invalid --port", 2);
  const profile = getStringOption(options, "tunnel-profile");
  if (profile && !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new CliError("Invalid tunnel profile", 2);
  const release = path.join(researchMcpHome(), "releases", metadata.releaseId);
  const value: ResearchMcpInstallation = {
    version: 1, instanceId: context.instanceId, enabled: previous?.enabled ?? true,
    entry: path.join(release, "index.cjs"), node: process.execPath,
    cwd: path.resolve(getStringOption(options, "cwd") ?? previous?.cwd ?? process.cwd()), port,
    ...metadata, installedAt: Date.now(),
    tunnel: profile ? {
      profile, executable: path.resolve(requireStringOption(options, "tunnel-executable")),
      profileDir: path.resolve(getStringOption(options, "tunnel-profile-dir") ?? path.join(os.homedir(), ".config", "tunnel-client")),
      healthFile: path.join(os.homedir(), "Library", "Application Support", "tunnel-client", "health", `${profile}.url`),
    } : previous?.tunnel ?? null,
  };
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Research MCP requires Node 22+");
  const digest = createHash("sha256").update(readFileSync(sourceEntry)).digest("hex");
  const recorded = metadata as typeof metadata & { bundleSha256?: string };
  if (recorded.bundleSha256 !== digest) throw new Error("Release bundle digest mismatch");
  if (existsSync(release)) {
    if (previous?.releaseId === metadata.releaseId && createHash("sha256").update(readFileSync(previous.entry)).digest("hex") === digest) {
      if (value.cwd !== previous.cwd || value.port !== previous.port || JSON.stringify(value.tunnel) !== JSON.stringify(previous.tunnel)) throw new Error("Build a fresh release to change installed service configuration");
      output({ installed: true, alreadyInstalled: true, enabled: previous.enabled, health: await health(previous.port) }); return;
    }
    throw new Error("Release identity already exists with different installation");
  }
  const managedRunning = !!previous?.enabled && jobRunning(0);
  const managedTunnel = jobRunning(1);
  const existing = await health(port);
  if (!managedRunning || !previous || (existing && (existing.service !== "runweave-research-mcp" || existing.instance !== previous.instanceId || existing.releaseId !== previous.releaseId))) await assertPortFree(port);
  const tunnelRunning = value.enabled ? checkTunnel(value) : false;
  if (tunnelRunning && !managedTunnel && options["adopt-tunnel"] !== true) throw new Error("Existing tunnel requires explicit --adopt-tunnel takeover");
  let switched = false;
  try {
    mkdirSync(release, { recursive: true, mode: 0o700 });
    cpSync(sourceEntry, value.entry);
    cpSync(path.join(path.dirname(sourceEntry), "node_modules"), path.join(release, "node_modules"), { recursive: true, dereference: true });
    cpSync(path.join(path.dirname(sourceEntry), "release.json"), path.join(release, "release.json"));
    await preflight(value);
    if (tunnelRunning && !managedTunnel && value.tunnel) {
      const result = spawnSync(value.tunnel.executable, ["runtimes", "stop", value.tunnel.profile], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("Could not stop verified previous tunnel owner");
    }
    await unload();
    switched = true;
    await waitPortFree(value.port);
    writeResearchMcpInstallation(value);
    if (value.enabled) { await load(value); await waitHealthy(value); }
    output({ installed: true, enabled: value.enabled, health: value.enabled ? await health(value.port) : null });
  } catch (error) {
    try {
      if (switched) {
        await unload();
        for (const job of jobs()) rmSync(job.file, { force: true });
        if (previous) { writeResearchMcpInstallation(previous); if (previous.enabled) { await load(previous); await waitHealthy(previous); } }
        else rmSync(path.join(researchMcpHome(), "installation.json"), { force: true });
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Research MCP update failed and previous service could not be restored; inspect service logs");
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
    throw error;
  }
}
