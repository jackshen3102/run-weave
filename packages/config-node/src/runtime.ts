import { CONFIGURATION_FIELDS, readConfigurationPath, type ConfigurationValue, type ConfigurationStatus, type EnvironmentContext } from "@runweave/shared/configuration";
import { ConfigurationStore, type ConfigurationSnapshot } from "./store";
import { resolveConfigurationContext } from "./context";
import { domainForPath, redactConfiguration } from "./validation";
import { ConfigurationError } from "./errors";
import path from "node:path";
import { assertOwnedPath } from "./context";

export class ConfigurationRuntime {
  readonly store: ConfigurationStore;
  private snapshot: ConfigurationSnapshot;
  private readonly consumers = new Map<string, (snapshot: ConfigurationSnapshot) => Promise<void> | void>();
  private readonly applied = new Map<string, number>();
  private readonly snapshots = new Map<string, ConfigurationSnapshot>();
  private readonly applyErrors = new Map<string, string>();
  private reloadQueue: Promise<unknown> = Promise.resolve();
  private observed: ConfigurationSnapshot;
  constructor(readonly context: EnvironmentContext) {
    this.store = new ConfigurationStore(context);
    this.snapshot = this.store.read();
    this.observed = this.snapshot;
  }
  get<T extends ConfigurationValue>(key: string, fallback?: T): T | undefined {
    const domain = domainForPath(key);
    const snapshot = this.snapshots.get(domain) ?? this.snapshot;
    if (snapshot.issues[domain]?.length) return fallback;
    const value = readConfigurationPath(snapshot.value, key);
    return value === undefined || value === null ? fallback : value as T;
  }
  requireDomain(domain: string): void {
    const snapshot = this.snapshots.get(domain) ?? this.snapshot;
    if (snapshot.issues[domain]?.length) throw new ConfigurationError("CONFIG_DOMAIN_INVALID", snapshot.issues[domain]!.map((item) => item.path));
  }
  register(domain: string, apply: (snapshot: ConfigurationSnapshot) => Promise<void> | void): () => void {
    this.consumers.set(domain, apply);
    this.snapshots.set(domain, this.snapshot);
    if (!this.snapshot.issues[domain]?.length && !this.applyErrors.has(domain)) this.applied.set(domain, this.snapshot.value.revision);
    return () => { this.consumers.delete(domain); this.applied.delete(domain); this.snapshots.delete(domain); };
  }
  markApplied(...domains: string[]): void {
    this.markSnapshotApplied(this.snapshot, ...domains);
  }
  markSnapshotApplied(saved: ConfigurationSnapshot, ...domains: string[]): void {
    for (const domain of domains) {
      if (saved.issues[domainForPath(domain)]?.length) throw new ConfigurationError("CONFIG_DOMAIN_INVALID", [domain]);
      this.snapshots.set(domain, saved);
      this.applied.set(domain, saved.value.revision);
      this.applyErrors.delete(domain);
    }
  }
  reportError(domain: string): void { this.applyErrors.set(domain, "CONFIG_APPLY_FAILED"); }
  reload(): Promise<ConfigurationStatus> {
    const result = this.reloadQueue.then(() => this.applyReload());
    this.reloadQueue = result.catch(() => undefined);
    return result;
  }
  private async applyReload(): Promise<ConfigurationStatus> {
    let candidate = this.store.read();
    const known = [this.observed, this.snapshot, ...this.snapshots.values()];
    if (!Object.keys(candidate.issues).length && !known.some((entry) => entry.digest === candidate.digest) && candidate.value.revision <= Math.max(...known.map((entry) => entry.value.revision))) {
      candidate = this.store.patch({ expectedRevision: candidate.value.revision, expectedDigest: candidate.digest, changes: {} }, { minimumRevision: Math.max(...known.map((entry) => entry.value.revision)) });
    }
    this.observed = candidate;
    for (const [domain, apply] of this.consumers) {
      if (candidate.issues[domain]?.length) continue;
      if (this.snapshots.get(domain)?.digest === candidate.digest && !this.applyErrors.has(domain)) continue;
      try {
        await apply(candidate);
        this.snapshots.set(domain, candidate);
        this.applied.set(domain, candidate.value.revision);
        this.applyErrors.delete(domain);
      } catch { this.applyErrors.set(domain, "CONFIG_APPLY_FAILED"); }
    }
    return this.status();
  }
  status(): ConfigurationStatus {
    let saved: ConfigurationSnapshot;
    try { saved = this.store.read(); }
    catch (error) {
      return {
        environment: { kind: this.context.kind, instanceId: this.context.instanceId },
        savedRevision: null, digest: null, values: {},
        diskError: { code: error instanceof ConfigurationError ? error.code : "CONFIG_READ_FAILED", ...(error instanceof ConfigurationError && error.location ? { location: error.location } : {}) },
        consumers: Object.fromEntries([...this.applied].map(([domain, appliedRevision]) => [domain, { appliedRevision, state: "applied", issues: [] }])),
      };
    }
    return {
      environment: { kind: this.context.kind, instanceId: this.context.instanceId },
      savedRevision: saved.value.revision,
      digest: saved.digest,
      values: redactConfiguration(saved.value),
      consumers: Object.fromEntries([...new Set([...CONFIGURATION_FIELDS.map((field) => field.domain), ...Object.keys(saved.value.domainVersions), ...this.applied.keys()])].map((domain) => {
        const issues = saved.issues[domainForPath(domain)] ?? (this.applyErrors.has(domain) ? [{ path: domain, code: "CONFIG_APPLY_FAILED" }] : []);
        const appliedRevision = this.applied.get(domain) ?? null;
        const value = readConfigurationPath(saved.value, domain);
        const empty = value === undefined || value === null || typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => entry === null);
        const applied = this.snapshots.get(domain);
        const unchanged = applied && JSON.stringify(readConfigurationPath(applied.value, domain)) === JSON.stringify(value);
        return [domain, { appliedRevision, state: issues.length ? "error" : empty && (appliedRevision === null || ["services.snapshotPublisher", "services.pushSender", "services.feishu"].includes(domain)) ? "unconfigured" : appliedRevision !== null && unchanged ? "applied" : "restartRequired", issues }];
      })),
    };
  }
}

let active: ConfigurationRuntime | undefined;
export function initializeConfiguration(context = resolveConfigurationContext()): ConfigurationRuntime {
  if (active && (active.context.configRoot !== context.configRoot || active.context.instanceId !== context.instanceId)) throw new ConfigurationError("CONFIG_PROCESS_IDENTITY_CHANGED");
  return active ??= new ConfigurationRuntime(context);
}
export function configuration(): ConfigurationRuntime { return active ?? initializeConfiguration(); }
export function setting<T extends ConfigurationValue>(key: string, fallback?: T): T | undefined { return configuration().get(key, fallback); }
export function settingText(key: string): string | undefined {
  const value = setting(key);
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") throw new ConfigurationError("CONFIG_SCALAR_REQUIRED", [key]);
  return String(value);
}
export function configurationPath(key: string, relativeDefault: string): string {
  const runtime = configuration();
  runtime.requireDomain(domainForPath(key));
  const value = settingText(key) ?? path.join(runtime.context.configRoot, "data", relativeDefault);
  if (!path.isAbsolute(value)) throw new ConfigurationError("CONFIG_PATH_MUST_BE_ABSOLUTE", [key]);
  assertOwnedPath(runtime.context, value);
  return value;
}
