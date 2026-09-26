import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CONFIGURATION_FIELDS, readConfigurationPath, isConfigurationObject, type ConfigurationFile, type ConfigurationObject, type ConfigurationValue, type EnvironmentContext } from "@runweave/shared/configuration";
import { emptyConfiguration, setConfigurationValue, ConfigurationStore } from "./store";
import { assertPrivateDirectory, readPrivateFile } from "./private-file";
import { ConfigurationError } from "./errors";
import { validateDomains, redactConfiguration, domainForPath } from "./validation";

export interface MigrationSource { file: string; domain: string; format: "json" | "env" }
export interface MigrationDraft { value: ConfigurationFile; sources: { file: string; digest: string; domain: string }[]; conflicts: string[] }

export function parseEnvironmentFile(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) throw new ConfigurationError("CONFIG_ENV_SYNTAX_INVALID");
    let value = match[2]!;
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (Object.hasOwn(result, match[1]!)) throw new ConfigurationError("CONFIG_ENV_DUPLICATE", [match[1]!]);
    result[match[1]!] = value;
  }
  return result;
}

export function importEnvironment(value: ConfigurationFile, environment: Record<string, string | undefined>): void {
  for (const field of CONFIGURATION_FIELDS) {
    const aliases = field.environmentKeys.filter((key) => environment[key] !== undefined);
    if (!aliases.length) continue;
    const raw = environment[aliases[0]!]!;
    if (aliases.some((key) => environment[key] !== raw)) throw new ConfigurationError("CONFIG_SOURCE_CONFLICT", [field.path]);
    let parsed: ConfigurationValue = raw;
    if (field.type === "integer" || field.type === "number") parsed = Number(raw);
    if (field.type === "boolean") {
      if (!/^(true|false|1|0|yes|no|on|off)$/i.test(raw)) throw new ConfigurationError("CONFIG_BOOLEAN_INVALID", [field.path]);
      parsed = /^(true|1|yes|on)$/i.test(raw);
    }
    if (field.type === "array<string>") parsed = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
    setConfigurationValue(value, field.path, parsed);
  }
}

export function prepareMigration(context: EnvironmentContext, sources: MigrationSource[]): MigrationDraft {
  const store = new ConfigurationStore(context);
  const initial = existsSync(store.file) ? store.read().value : emptyConfiguration(context);
  const value = structuredClone(initial);
  const result: MigrationDraft = { value, sources: [], conflicts: [] };
  const byDomain = new Map<string, string>();
  const migratedDomains = new Set(Object.keys(value.migrations));
  for (const source of sources) {
    if (!path.isAbsolute(source.file)) throw new ConfigurationError("CONFIG_SOURCE_PATH_REQUIRED");
    if (migratedDomains.has(source.domain)) continue;
    const raw = readFileSync(source.file, "utf8");
    const digest = createHash("sha256").update(raw).digest("hex");
    const previous = byDomain.get(source.domain);
    if (previous && previous !== digest) { result.conflicts.push(source.domain); continue; }
    byDomain.set(source.domain, digest);
    const draft = emptyConfiguration(context);
    if (source.format === "env") importEnvironment(draft, parseEnvironmentFile(raw));
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new ConfigurationError("CONFIG_LEGACY_JSON_INVALID"); }
      if (!isConfigurationObject(parsed)) throw new ConfigurationError("CONFIG_LEGACY_OBJECT_REQUIRED");
      if (source.domain === "cli") {
        if (!isConfigurationObject(parsed.profiles) || typeof parsed.activeProfile !== "string") throw new ConfigurationError("CONFIG_LEGACY_CLI_INVALID");
        setConfigurationValue(draft, "cli", { activeProfile: parsed.activeProfile, profiles: parsed.profiles });
      } else if (source.domain === "backend.auth") {
        const auth = isConfigurationObject(parsed.auth) ? parsed.auth : parsed;
        const fields = Object.fromEntries(Object.entries(auth).filter(([key]) => !["updatedAt", "createdAt", "refreshSessions"].includes(key)));
        setConfigurationValue(draft, source.domain, fields);
      } else if (source.domain === "desktop.preferences.companion") {
        if (typeof parsed.enabled !== "boolean") throw new ConfigurationError("CONFIG_LEGACY_COMPANION_INVALID");
        setConfigurationValue(draft, source.domain, { enabled: parsed.enabled });
      } else if (source.domain === "desktop.browser" && parsed.version === 1) {
        if (!isConfigurationObject(parsed.worktrees) || typeof parsed.defaultProfileId !== "string") throw new ConfigurationError("CONFIG_LEGACY_BROWSER_INVALID");
        const worktrees: ConfigurationObject = {}, pending: ConfigurationObject = {};
        for (const [id, preference] of Object.entries(parsed.worktrees)) {
          if (!isConfigurationObject(preference)) throw new ConfigurationError("CONFIG_LEGACY_BROWSER_INVALID");
          worktrees[id] = { preferredProfileId: preference.preferredProfileId ?? null };
          if (preference.devServerPort != null) {
            const profile = preference.preferredProfileId ?? parsed.defaultProfileId;
            if (typeof profile !== "string" || !Number.isInteger(preference.devServerPort) || Number(preference.devServerPort) < 1 || Number(preference.devServerPort) > 65535) throw new ConfigurationError("CONFIG_LEGACY_BROWSER_INVALID");
            pending[profile] = [...new Set([...(pending[profile] as number[] ?? []), Number(preference.devServerPort)])];
          }
        }
        setConfigurationValue(draft, source.domain, { defaultProfileId: parsed.defaultProfileId, businessOrigin: parsed.businessOrigin ?? null, proxyModes: parsed.proxyModes ?? {}, profilePorts: {}, worktrees, pendingPortMigration: pending });
      } else if (source.domain === "agents.team") {
        if (!isConfigurationObject(parsed.config) || !isConfigurationObject(parsed.config.roles)) throw new ConfigurationError("CONFIG_LEGACY_MODELS_INVALID");
        setConfigurationValue(draft, source.domain, { roles: parsed.config.roles, updatedAt: parsed.config.updatedAt ?? null });
      } else {
        const fields = Object.fromEntries(Object.entries(parsed).filter(([key]) => !(source.domain === "desktop.tunnels" ? ["schemaVersion"] : ["version", "schemaVersion", "revision", "createdAt", "updatedAt"]).includes(key)));
        setConfigurationValue(draft, source.domain, fields);
      }
    }
    const keys = source.domain.split(".");
    let selected: ConfigurationValue | undefined = draft;
    for (const key of keys) selected = isConfigurationObject(selected) ? selected[key] : undefined;
    if (selected === undefined) throw new ConfigurationError("CONFIG_SOURCE_DOMAIN_MISSING", [source.domain]);
    // Existing YAML choices are never overwritten by an unselected legacy source.
    // Merge disjoint nested preferences but treat credential groups as one source.
    const changes = migrationLeaves(selected, source.domain);
    const credentialGroups = {
      "backend.auth": ["username", "password", "jwtSecret"],
      "services.snapshotPublisher": ["url", "token"],
      "services.pushSender": ["gatewayURL", "senderToken", "hostId"],
      "services.feishu": ["appId", "appSecret"],
    };
    const group = credentialGroups[source.domain as keyof typeof credentialGroups];
    if (group) {
      const existing = group.map((key) => readConfigurationPath(value, `${source.domain}.${key}`));
      const incoming = group.map((key) => readConfigurationPath(draft, `${source.domain}.${key}`));
      if (existing.some((entry) => entry != null) && existing.some((entry, index) => entry !== incoming[index])) {
        result.conflicts.push(source.domain);
        continue;
      }
    }
    const conflicts = changes.filter(([key, entry]) => {
      const existing = readConfigurationPath(value, key);
      return existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry);
    });
    if (conflicts.length) { result.conflicts.push(...conflicts.map(([key]) => key)); continue; }
    for (const [key, entry] of changes) setConfigurationValue(value, key, entry);
    value.migrations[source.domain] = { id: `${source.domain}:${digest}`, sourceDigest: digest };
    result.sources.push({ file: source.file, digest, domain: source.domain });
  }
  const issues = validateDomains(value, context);
  const touched = new Set(result.sources.map((source) => domainForPath(source.domain)));
  result.conflicts.push(...Object.entries(issues).filter(([domain]) => touched.has(domain)).flatMap(([, entries]) => entries.map((issue) => issue.path)));
  return result;
}

export function migrationPreview(draft: MigrationDraft): ConfigurationObject {
  return { values: redactConfiguration(draft.value), sources: draft.sources, conflicts: draft.conflicts };
}

function migrationLeaves(value: ConfigurationValue, prefix: string): [string, ConfigurationValue][] {
  if (isConfigurationObject(value) && Object.keys(value).length) return Object.entries(value).flatMap(([key, entry]) => migrationLeaves(entry, `${prefix}.${key.replace(/\\/g, "\\\\").replace(/\./g, "\\.")}`));
  return [[prefix, value]];
}

/** Back up each reviewed source before publishing; never follow a backup symlink. */
export function backupMigrationSources(context: EnvironmentContext, draft: MigrationDraft): void {
  mkdirSync(context.configRoot, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(context.configRoot);
  const directory = path.join(context.configRoot, "config-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(directory);
  for (const source of draft.sources) {
    const raw = readFileSync(source.file);
    if (createHash("sha256").update(raw).digest("hex") !== source.digest) throw new ConfigurationError("CONFIG_SOURCE_CHANGED");
    const target = path.join(directory, `migration-${source.digest}.source`);
    if (existsSync(target)) {
      if (createHash("sha256").update(readPrivateFile(target, raw.length)).digest("hex") !== source.digest) throw new ConfigurationError("CONFIG_BACKUP_INVALID");
      continue;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, target); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
