import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { RuntimeStatusReport } from "@runweave/shared/runtime-status";
import { isRuntimeStatusCapabilityId, isRuntimeStatusState } from "@runweave/shared/runtime-status";
import type { RuntimeBuildInfo } from "@runweave/shared/runtime-version";
import { runtimeBuildInfo, runtimeVersionFacts, runtimeInstallationFacts } from "@runweave/shared/runtime-version";
import { configuration } from "./runtime";
import { assertPrivateDirectory, readPrivateFile } from "./private-file";

export const LOCAL_RUNTIME_STATUS_SOURCES = ["electron", "snapshot-host", "push-gateway", "suiji-server"] as const;
export type LocalRuntimeStatusSource = typeof LOCAL_RUNTIME_STATUS_SOURCES[number];

function directory(): string { return path.join(configuration().context.configRoot, "runtime-status"); }

export function validateLocalRuntimeStatusReport(value: unknown, source: string): RuntimeStatusReport {
  const report = value as RuntimeStatusReport;
  if (report?.protocolVersion !== 1 || report.source?.id !== source || report.source.runtime !== source || !isRuntimeStatusCapabilityId(report.source.capabilityId) ||
      typeof report.source.instanceId !== "string" || !Number.isFinite(report.observedAt) || !Number.isFinite(report.validForMs) || report.validForMs < 10 || report.validForMs > 300_000 ||
      !Array.isArray(report.items) || report.items.length > 256 || report.items.some(item =>
        typeof item.id !== "string" || !item.id.startsWith(`${source}.`) || !isRuntimeStatusState(item.state) || !isRuntimeStatusCapabilityId(item.capabilityId) ||
        typeof item.label !== "string" || typeof item.summary !== "string" || !Number.isFinite(item.observedAt) ||
        !Array.isArray(item.dependsOn) || item.dependsOn.some(id => typeof id !== "string") ||
        !Array.isArray(item.facts) || item.facts.some(fact => typeof fact.id !== "string" || typeof fact.label !== "string" || typeof fact.value !== "string" || !["address", "port", "text", "time"].includes(fact.kind)))) throw new Error("Invalid local runtime status report");
  return report;
}

export function readNativeHostRuntimeStatusReport(): { report: RuntimeStatusReport; receivedAt: number } | null {
  const root = path.join(os.homedir(), "Library", "Application Support", "RemoteDesk");
  const file = path.join(root, "runtime-status.json");
  if (!existsSync(file)) return null;
  assertPrivateDirectory(root);
  return { report: validateLocalRuntimeStatusReport(JSON.parse(readPrivateFile(file, 64 * 1024)), "remote-desktop-host"), receivedAt: statSync(file).mtimeMs };
}

/** Legacy Host owner evidence; installing the app alone does not enable sharing. */
export function readNativeHostSharingEnabled(): boolean {
  const root = path.join(os.homedir(), "Library", "Application Support", "RemoteDesk");
  const file = path.join(root, "local-host.json");
  if (!existsSync(file)) return false;
  assertPrivateDirectory(root);
  const value = JSON.parse(readPrivateFile(file, 16 * 1024));
  if (value.schemaVersion !== 1 || typeof value.running !== "boolean") throw new Error("Invalid native Host sharing intent");
  return value.running;
}

/** Only the lifecycle owner publishes; a consumer never probes arbitrary ports or commands. */
export function startLocalRuntimeStatusReporter(source: LocalRuntimeStatusSource, report: () => RuntimeStatusReport | Promise<RuntimeStatusReport>): () => Promise<void> {
  const root = directory();
  const file = path.join(root, `${source}.json`);
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let latest: RuntimeStatusReport | null = null;
  const write = (snapshot: RuntimeStatusReport, stopping = false) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(root);
    if (snapshot.source.id !== source) throw new Error("Runtime status owner mismatch");
    if (stopping) snapshot = { ...snapshot, observedAt: Date.now(), items: snapshot.items.map(item => ({ ...item, state: "disabled", summary: "服务已正常停止", recovery: null })) };
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ instanceId: configuration().context.instanceId, report: snapshot, stopped: stopping }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  };
  const publish = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= Promise.resolve().then(report).then(snapshot => { latest = snapshot; if (!stopped) write(snapshot); })
      .catch(() => { console.error("Local runtime status publication failed"); }).finally(() => { inFlight = null; });
    return inFlight;
  };
  void publish();
  const timer = setInterval(() => void publish(), 5_000);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); await inFlight; try { if (latest) write(latest, true); } catch { console.error("Local runtime status shutdown publication failed"); } };
}

export function startLocalServiceProcessReporter(source: Exclude<LocalRuntimeStatusSource, "electron">, label: string, health: () => { ready: boolean; port: number; summary: string } | Promise<{ ready: boolean; port: number; summary: string }>): () => Promise<void> {
  const running = runtimeBuildInfo();
  const instanceId = `${source}:${process.pid}:${randomUUID()}`;
  return startLocalRuntimeStatusReporter(source, async () => {
    const status = await health();
    const now = Date.now();
    return { protocolVersion: 1, target: { kind: "local-host" }, source: { id: source, runtime: source, instanceId, capabilityId: "node" }, observedAt: now, validForMs: 20_000,
      items: [{ id: `${source}.process`, capabilityId: "node", label, state: status.ready ? "healthy" : "unhealthy", summary: status.summary, observedAt: now, dependsOn: [], recovery: null, navigation: null,
        facts: [...runtimeVersionFacts(running), ...runtimeInstallationFacts(running, readInstalledRuntimeBuild(process.argv[1])), { id: `${source}.port`, label: "端口", value: String(status.port), kind: "port", copyable: true }] }] };
  });
}

export function readLocalRuntimeStatusReport(source: LocalRuntimeStatusSource): { report: RuntimeStatusReport; receivedAt: number; stopped: boolean } | null {
  const root = directory();
  const file = path.join(root, `${source}.json`);
  if (!existsSync(file)) return null;
  assertPrivateDirectory(root);
  const value = JSON.parse(readPrivateFile(file, 256 * 1024));
  if (value.instanceId !== configuration().context.instanceId) throw new Error("Local runtime status instance mismatch");
  const report = validateLocalRuntimeStatusReport(value.report, source);
  if (value.stopped === true && report.items.some(item => item.state !== "disabled")) throw new Error("Invalid stopped owner report");
  return { report, receivedAt: statSync(file).mtimeMs, stopped: value.stopped === true };
}

/** Build identity embedded by our publisher. Read a bounded header; never load executable code. */
export function readInstalledRuntimeBuild(entry: string | undefined): RuntimeBuildInfo | null {
  if (!entry || !path.isAbsolute(entry)) return null;
  let fd: number | undefined;
  try {
    // Immutable releases retain their original paths. Compare against the owner's
    // selected pointer so an installed update cannot be mistaken for a restart.
    const marker = `${path.sep}releases${path.sep}`;
    const index = entry.lastIndexOf(marker);
    if (index >= 0) {
      const root = entry.slice(0, index);
      const relative = entry.slice(index + marker.length).split(path.sep).slice(1);
      const pointer = path.join(root, "current.json");
      if (existsSync(pointer)) {
        const selected = JSON.parse(readFileSync(pointer, "utf8"));
        if (!/^[a-zA-Z0-9._-]+$/.test(selected.releaseId) || [".", ".."].includes(selected.releaseId)) return null;
        entry = path.join(root, "releases", selected.releaseId, ...relative);
      }
    }
    fd = openSync(entry, "r");
    const buffer = Buffer.alloc(8192);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const match = buffer.subarray(0, length).toString("utf8").split("\n", 1)[0]?.match(/var __RUNWEAVE_BUILD_INFO__=(\{.*\});/);
    const metadata = path.join(path.dirname(entry), "release.json");
    const value = match ? JSON.parse(match[1]!) : JSON.parse(readFileSync(existsSync(metadata) ? metadata : path.join(path.dirname(entry), "build-info.json"), "utf8"));
    return typeof value.version === "string" && typeof value.buildId === "string" ? value : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
