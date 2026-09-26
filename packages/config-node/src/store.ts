import "./native-lock";
import { registerStableConfigurationRoot } from "./owner";
import {
  constants, existsSync, lstatSync, readdirSync, mkdirSync, openSync, closeSync,
  readFileSync, writeFileSync, fstatSync, fsyncSync, renameSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Document, Lexer, Parser, isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import { tryLock } from "fs-native-extensions";
import {
  readConfigurationPath, configurationPathSegments, isConfigurationObject, type ConfigurationFile, type ConfigurationPatch,
  type ConfigurationValue, type EnvironmentContext, CONFIGURATION_COMPATIBILITY, supportsConfiguration,
} from "@runweave/shared/configuration";
import { ConfigurationError } from "./errors";
import { validateDomains, validateEnvelope, domainForPath, fieldForPath, isConfigurationContainer, flattenConfiguration } from "./validation";
import { assertPrivateDirectory, readPrivateFile } from "./private-file";

const MAX_BYTES = 1024 * 1024;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor", "<<"]);

function yamlError(code: string, source: string, offset = 0): ConfigurationError {
  const prefix = source.slice(0, offset);
  return new ConfigurationError(code, [], { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") });
}

function checkNode(node: Node | null, source: string, depth = 0): void {
  if (!node) return;
  if (depth > 32) throw yamlError("CONFIG_YAML_DEPTH_LIMIT", source, node.range?.[0]);
  if (isAlias(node) || node.anchor || node.tag) throw yamlError("CONFIG_YAML_EXTENSION_FORBIDDEN", source, node.range?.[0]);
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.tag || pair.key.anchor || unsafeKeys.has(pair.key.value)) throw yamlError("CONFIG_YAML_KEY_INVALID", source, isScalar(pair.key) ? pair.key.range?.[0] : node.range?.[0]);
      checkNode(pair.value as Node | null, source, depth + 1);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) checkNode(item as Node | null, source, depth + 1);
  } else if (isScalar(node) && !(node.value === null || ["string", "boolean", "number"].includes(typeof node.value)) || isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value)) {
    throw yamlError("CONFIG_YAML_VALUE_INVALID", source, node.range?.[0]);
  }
}

function parseYamlDocument(source: string) {
  if (Buffer.byteLength(source) > MAX_BYTES) throw yamlError("CONFIG_FILE_TOO_LARGE", source);
  // yaml's debug switch prints raw tokens. Never parse private data with it set.
  if (process.env.LOG_TOKENS) throw new ConfigurationError("CONFIG_UNSAFE_PARSER_DEBUG");
  // Bound the parser stack before composition can recurse into arbitrary depth.
  const parser = new Parser();
  for (const lexeme of new Lexer().lex(source)) {
    for (const token of parser.next(lexeme)) if (token.type === "error") throw yamlError("CONFIG_YAML_INVALID", source, token.offset);
    if (parser.stack.length > 34) throw yamlError("CONFIG_YAML_DEPTH_LIMIT", source, parser.stack.at(-1)?.offset);
  }
  let document: ReturnType<typeof parseDocument>;
  try { document = parseDocument(source, { version: "1.2", schema: "core", uniqueKeys: true, merge: false, prettyErrors: false }); }
  catch { throw yamlError("CONFIG_YAML_INVALID", source); }
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw yamlError("CONFIG_YAML_INVALID", source, problem.pos[0]);
  if (!isMap(document.contents)) throw yamlError("CONFIG_ROOT_INVALID", source, document.contents?.range?.[0]);
  checkNode(document.contents, source);
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  return { document, value };
}

export function parseConfigurationYaml(source: string, context: EnvironmentContext) {
  const { document, value } = parseYamlDocument(source);
  validateEnvelope(value, context);
  return { document, value, digest: createHash("sha256").update(source).digest("hex"), issues: validateDomains(value, context) };
}

export type ConfigurationSnapshot = ReturnType<typeof parseConfigurationYaml>;

function assertPrivateFile(file: string, fd?: number): void {
  const stat = fd === undefined ? lstatSync(file) : fstatSync(fd);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ConfigurationError("CONFIG_FILE_NOT_PRIVATE_REGULAR");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_FILE_OWNER_MISMATCH");
  if ((stat.mode & 0o077) !== 0) throw new ConfigurationError("CONFIG_FILE_PERMISSIONS_INVALID");
  if (stat.size > MAX_BYTES) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE", [], { line: 1, column: 1 });
}

export class ConfigurationStore {
  readonly file: string;
  constructor(readonly context: EnvironmentContext) { this.file = path.join(context.configRoot, "settings.yaml"); }

  read(): ConfigurationSnapshot {
    if (!existsSync(this.file)) throw new ConfigurationError("CONFIG_MIGRATION_REQUIRED");
    const root = lstatSync(this.context.configRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || typeof process.getuid === "function" && root.uid !== process.getuid()) throw new ConfigurationError("CONFIG_ROOT_PERMISSIONS_INVALID");
    assertPrivateFile(this.file);
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertPrivateFile(this.file, fd);
      return parseConfigurationYaml(readFileSync(fd, "utf8"), this.context);
    }
    finally { closeSync(fd); }
  }

  private locked<T>(run: () => T): T {
    mkdirSync(this.context.configRoot, { recursive: true, mode: 0o700 });
    const dirStat = lstatSync(this.context.configRoot);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (typeof process.getuid === "function" && dirStat.uid !== process.getuid())) throw new ConfigurationError("CONFIG_ROOT_OWNER_MISMATCH");
    if ((dirStat.mode & 0o077) !== 0) throw new ConfigurationError("CONFIG_ROOT_PERMISSIONS_INVALID");
    // Never unlink: the kernel releases the lock on process exit and reboot.
    const fd = openSync(path.join(this.context.configRoot, "settings.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      assertPrivateFile(path.join(this.context.configRoot, "settings.lock"), fd);
      if (!tryLock(fd)) throw new ConfigurationError("CONFIG_WRITE_BUSY");
      return run();
    } finally { closeSync(fd); }
  }

  private publish(document: Document, previous?: string): ConfigurationSnapshot {
    const source = document.toString({ lineWidth: 0 });
    const checked = parseConfigurationYaml(source, this.context);
    registerStableConfigurationRoot(this.context);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    if (previous !== undefined) {
      const backupRoot = path.join(this.context.configRoot, "config-backups");
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backupStat = lstatSync(backupRoot);
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink() || backupStat.mode & 0o077 || typeof process.getuid === "function" && backupStat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_BACKUP_ROOT_INVALID");
      const backup = path.join(backupRoot, `${Date.now()}-${randomUUID()}.yaml`);
      const fd = openSync(backup, "wx", 0o600);
      try { writeFileSync(fd, previous); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, source); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(temporary, this.file);
      const parent = openSync(this.context.configRoot, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return checked;
  }

  initialize(value: ConfigurationFile): ConfigurationSnapshot {
    return this.locked(() => {
      if (existsSync(this.file)) throw new ConfigurationError("CONFIG_ALREADY_EXISTS");
      validateEnvelope(value, this.context);
      const issues = validateDomains(value, this.context);
      if (Object.keys(issues).length) throw new ConfigurationError("CONFIG_VALIDATION_FAILED", Object.values(issues).flat().map((item) => item.path));
      return this.publish(new Document(value));
    });
  }

  patch(input: ConfigurationPatch, options: { remote?: boolean; minimumRevision?: number } = {}): ConfigurationSnapshot {
    return this.locked(() => {
      const current = this.read();
      if (current.value.revision !== input.expectedRevision || current.digest !== input.expectedDigest) throw new ConfigurationError("CONFIG_REVISION_CONFLICT");
      const domains = new Set<string>();
      for (const [key, value] of Object.entries(input.changes)) {
        const segments = configurationPathSegments(key);
        if (!segments.length || segments.some((part) => !part || unsafeKeys.has(part))) throw new ConfigurationError("CONFIG_FIELD_INVALID");
        const domain = domainForPath(key);
        if (current.value.domainVersions[domain] !== undefined && current.value.domainVersions[domain] !== 1) throw new ConfigurationError("CONFIG_DOMAIN_VERSION_UNSUPPORTED", [domain]);
        const field = fieldForPath(key);
        // Objects/arrays are checked leaf by leaf by the same schema after patch.
        if (!field && !(isConfigurationObject(value) && isConfigurationContainer(key)) && !(Array.isArray(value) && isConfigurationContainer(key, true)) && !(value === null && (isConfigurationContainer(key) || isConfigurationContainer(key, true)))) throw new ConfigurationError("CONFIG_FIELD_UNKNOWN", [key]);
        if (options.remote && (!field || !field.remote)) throw new ConfigurationError("CONFIG_FIELD_FORBIDDEN", [key]);
        if (field?.sensitive && (typeof value !== "string" && value !== null || value === "<redacted>" || value === "********")) throw new ConfigurationError("CONFIG_SECRET_VALUE_INVALID", [key]);
        if (["schemaVersion", "revision", "kind", "instanceId", "domainVersions", "migrations"].includes(segments[0]!)) throw new ConfigurationError("CONFIG_METADATA_IMMUTABLE");
        const target: (string | number)[] = [];
        for (const segment of segments) target.push(isSeq(current.document.getIn(target, true)) && /^\d+$/.test(segment) ? Number(segment) : segment);
        if (!field && value === null) current.document.deleteIn(target);
        else current.document.setIn(target, value);
        current.document.setIn(["domainVersions", domain], 1);
        domains.add(domain);
      }
      const revision = Math.max(current.value.revision, options.minimumRevision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new ConfigurationError("CONFIG_REVISION_INVALID");
      current.document.set("revision", revision);
      const checked = parseConfigurationYaml(current.document.toString(), this.context);
      const failures = [...domains].flatMap((domain) => checked.issues[domain] ?? []);
      if (failures.length) throw new ConfigurationError("CONFIG_VALIDATION_FAILED", failures.map((issue) => issue.path));
      return this.publish(current.document, readPrivateFile(this.file));
    });
  }

  backups(): Array<{ id: string; revision?: number; schemaVersion?: number; compatible: boolean; error?: string }> {
    const root = path.join(this.context.configRoot, "config-backups");
    if (!existsSync(root)) return [];
    assertPrivateDirectory(root);
    return readdirSync(root).filter((id) => /^\d+-[a-f0-9-]+\.yaml$/.test(id)).sort().reverse().map((id) => {
      try {
        const backup = this.readBackup(id);
        return { id, revision: backup.value.revision, schemaVersion: backup.value.schemaVersion, compatible: true };
      } catch (error) {
        return { id, compatible: false, error: error instanceof ConfigurationError ? error.code : "CONFIG_BACKUP_INVALID" };
      }
    });
  }

  private readBackup(id: string): ConfigurationSnapshot {
    if (!/^\d+-[a-f0-9-]+\.yaml$/.test(id)) throw new ConfigurationError("CONFIG_BACKUP_ID_INVALID");
    const root = path.join(this.context.configRoot, "config-backups");
    assertPrivateDirectory(root);
    const backup = parseConfigurationYaml(readPrivateFile(path.join(root, id)), this.context);
    if (Object.keys(backup.issues).length || !supportsConfiguration(CONFIGURATION_COMPATIBILITY, backup.value)) throw new ConfigurationError("CONFIG_BACKUP_INCOMPATIBLE");
    return backup;
  }

  private prepareRestore(id: string) {
    assertPrivateDirectory(this.context.configRoot);
    const source = readPrivateFile(this.file);
    const { value } = parseYamlDocument(source);
    if (!isConfigurationObject(value) || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) throw new ConfigurationError("CONFIG_SCHEMA_INVALID");
    // Read only the version-independent identity and revision envelope. Future
    // business fields remain opaque; ordinary reads still reject future schemas.
    validateEnvelope({ ...value, schemaVersion: 1 }, this.context);
    const backup = this.readBackup(id);
    const before = new Map(flattenConfiguration(value));
    const after = new Map(flattenConfiguration(backup.value));
    const changedFields = [...new Set([...before.keys(), ...after.keys()])].filter((key) => key !== "revision" && JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))).sort();
    return { source, backup, preview: {
      backupId: id, backupDigest: backup.digest,
      expectedRevision: Number(value.revision), expectedDigest: createHash("sha256").update(source).digest("hex"),
      currentSchemaVersion: Number(value.schemaVersion), targetSchemaVersion: backup.value.schemaVersion,
      changedFields, state: "restartRequired" as const,
    } };
  }

  previewRestore(id: string) { return this.prepareRestore(id).preview; }

  restoreBackup(id: string, expected: { revision: number; digest: string; backupDigest: string }): ConfigurationSnapshot {
    return this.locked(() => {
      const { source, backup, preview } = this.prepareRestore(id);
      if (preview.expectedRevision !== expected.revision || preview.expectedDigest !== expected.digest || preview.backupDigest !== expected.backupDigest) throw new ConfigurationError("CONFIG_REVISION_CONFLICT");
      const nextRevision = Math.max(preview.expectedRevision, backup.value.revision) + 1;
      if (!Number.isSafeInteger(nextRevision)) throw new ConfigurationError("CONFIG_REVISION_INVALID");
      backup.document.set("revision", nextRevision);
      // publish retains the complete pre-recovery bytes in a private backup.
      return this.publish(backup.document, source);
    });
  }

  previous(keys: string[]): Record<string, ConfigurationValue> {
    const current = this.read();
    const root = path.join(this.context.configRoot, "config-backups");
    if (!existsSync(root)) throw new ConfigurationError("CONFIG_BACKUP_UNAVAILABLE");
    assertPrivateDirectory(root);
    const candidates = readdirSync(root).filter((file) => /^\d+-[a-f0-9-]+\.yaml$/.test(file)).sort().reverse();
    for (const candidate of candidates) {
      const file = path.join(root, candidate);
      const previous = parseConfigurationYaml(readPrivateFile(file), this.context);
      if (keys.some((key) => previous.issues[domainForPath(key)]?.length)) continue;
      const changes = Object.fromEntries(keys.map((key) => [key, readConfigurationPath(previous.value, key) ?? null]));
      if (keys.some((key) => JSON.stringify(readConfigurationPath(current.value, key) ?? null) !== JSON.stringify(changes[key]))) return changes;
    }
    throw new ConfigurationError("CONFIG_BACKUP_UNAVAILABLE");
  }

  migrate(value: ConfigurationFile, expected: { revision: number; digest: string } | null): ConfigurationSnapshot {
    return this.locked(() => {
      const current = existsSync(this.file) ? this.read() : null;
      if (current ? !expected || current.value.revision !== expected.revision || current.digest !== expected.digest : expected !== null) throw new ConfigurationError("CONFIG_REVISION_CONFLICT");
      validateEnvelope(value, this.context);
      const issues = validateDomains(value, this.context);
      const failures = Object.entries(issues).filter(([domain]) => !current || JSON.stringify(readConfigurationPath(current.value, domain)) !== JSON.stringify(readConfigurationPath(value, domain)) || current.value.domainVersions[domain] !== value.domainVersions[domain]).flatMap(([, entries]) => entries);
      if (failures.length) throw new ConfigurationError("CONFIG_VALIDATION_FAILED", failures.map((item) => item.path));
      if (current && JSON.stringify(current.value) === JSON.stringify(value)) return current;
      const document = current?.document ?? new Document(value);
      if (current) {
        // Only changed domains are replaced; unrelated comments remain attached.
        for (const [key, entry] of Object.entries(value)) if (JSON.stringify(current.value[key]) !== JSON.stringify(entry)) document.set(key, entry);
      }
      document.set("revision", (current?.value.revision ?? 0) + 1);
      return this.publish(document, current ? readPrivateFile(this.file) : undefined);
    });
  }
}

export function emptyConfiguration(context: EnvironmentContext): ConfigurationFile {
  return { schemaVersion: 1, revision: 0, kind: context.kind, instanceId: context.instanceId, domainVersions: {}, migrations: {} };
}

export function setConfigurationValue(target: ConfigurationFile, key: string, value: ConfigurationValue): void {
  const parts = configurationPathSegments(key);
  let current = target as Record<string, ConfigurationValue>;
  for (const part of parts.slice(0, -1)) {
    if (unsafeKeys.has(part)) throw new ConfigurationError("CONFIG_FIELD_INVALID");
    const next = current[part];
    if (next !== undefined && !isConfigurationObject(next)) throw new ConfigurationError("CONFIG_FIELD_CONFLICT", [key]);
    current = (current[part] ??= {}) as Record<string, ConfigurationValue>;
  }
  const last = parts.at(-1)!;
  if (unsafeKeys.has(last)) throw new ConfigurationError("CONFIG_FIELD_INVALID");
  current[last] = value;
  target.domainVersions[domainForPath(key)] = 1;
}
