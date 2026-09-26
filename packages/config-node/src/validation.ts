import path from "node:path";
import {
  CONFIGURATION_FIELDS, isConfigurationObject, readConfigurationPath, configurationPathSegments, configurationPathSegment,
  type ConfigurationFile, type ConfigurationValue, type ConfigurationObject,
  type ConfigurationIssue, type ConfigurationField, type EnvironmentContext,
} from "@runweave/shared/configuration";
import { ConfigurationError } from "./errors";
import { assertOwnedPath } from "./context";

const patterns = CONFIGURATION_FIELDS.map((field) => ({ field, segments: field.path.replace(/\[\]/g, ".#").split(".") }));
export const BACKEND_CORE_CONFIGURATION_DOMAINS = ["backend.server", "backend.auth", "backend.tunnelAuth", "storage", "terminal", "logging", "agents.codex", "agents.traex"] as const;
function segmentMatches(pattern: string, value: string): boolean {
  return pattern === value || /^<[^>]+>$/.test(pattern) && value.length > 0 || pattern === "#" && /^\d+$/.test(value);
}
export function fieldForPath(key: string): ConfigurationField | undefined {
  const segments = configurationPathSegments(key);
  return patterns.find((entry) => entry.segments.length === segments.length && entry.segments.every((part, i) => segmentMatches(part, segments[i]!)))?.field;
}

// A container is valid only when its shape is declared by a descendant field.
export function isConfigurationContainer(key: string, array = false): boolean {
  const segments = configurationPathSegments(key);
  return CONFIGURATION_FIELDS.some((field) => {
    const parts = field.path.replace(/\[\]/g, ".#").split(".");
    return parts.length > segments.length && segments.every((segment, i) =>
      segmentMatches(parts[i]!, segment)) &&
      (array ? parts[segments.length] === "#" : parts[segments.length] !== "#");
  });
}

export function domainForPath(key: string): string {
  const parts = key.split(".");
  return ["backend", "services", "desktop", "agents"].includes(parts[0]!) ? parts.slice(0, 2).join(".") : parts[0]!;
}

export function validateEnvelope(value: unknown, context: EnvironmentContext): asserts value is ConfigurationFile {
  if (!isConfigurationObject(value)) throw new ConfigurationError("CONFIG_ROOT_INVALID");
  if (value.schemaVersion !== 1) throw new ConfigurationError("CONFIG_SCHEMA_UNSUPPORTED");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new ConfigurationError("CONFIG_REVISION_INVALID");
  if (value.kind !== context.kind || value.instanceId !== context.instanceId) throw new ConfigurationError("CONFIG_IDENTITY_MISMATCH");
  if (!isConfigurationObject(value.domainVersions) || !isConfigurationObject(value.migrations)) throw new ConfigurationError("CONFIG_METADATA_INVALID");
  for (const version of Object.values(value.domainVersions)) {
    if (!Number.isSafeInteger(version) || Number(version) < 1) throw new ConfigurationError("CONFIG_DOMAIN_VERSION_INVALID");
  }
}

export function flattenConfiguration(value: ConfigurationValue, prefix = ""): [string, ConfigurationValue][] {
  if (isConfigurationObject(value) && Object.keys(value).length) return Object.entries(value).flatMap(([key, entry]) => flattenConfiguration(entry, prefix ? `${prefix}.${configurationPathSegment(key)}` : configurationPathSegment(key)));
  if (Array.isArray(value) && value.some(isConfigurationObject)) return value.flatMap((entry, index) => flattenConfiguration(entry, `${prefix}.${index}`));
  return [[prefix, value]];
}

export function validateDomains(value: ConfigurationFile, context: EnvironmentContext): Record<string, ConfigurationIssue[]> {
  const result: Record<string, ConfigurationIssue[]> = {};
  const issue = (key: string, code: string) => { (result[domainForPath(key)] ??= []).push({ path: key, code }); };
  for (const [key, entry] of flattenConfiguration(value)) {
    if (["schemaVersion", "revision", "kind", "instanceId", "domainVersions", "migrations"].includes(key.split(".")[0]!)) continue;
    const domain = domainForPath(key);
    if (value.domainVersions[domain] !== undefined && value.domainVersions[domain] !== 1) { issue(key, "CONFIG_DOMAIN_VERSION_UNSUPPORTED"); continue; }
    const field = fieldForPath(key);
    if (!field) {
      if (isConfigurationObject(entry) && !Object.keys(entry).length && isConfigurationContainer(key) || Array.isArray(entry) && !entry.length && isConfigurationContainer(key, true)) continue;
      issue(key, "CONFIG_FIELD_UNKNOWN"); continue;
    }
    if (entry === null) continue;
    const valid = field.type === "array<number>" ? Array.isArray(entry) && entry.every((item) => typeof item === "number" && Number.isFinite(item))
      : field.type === "array<string>" ? Array.isArray(entry) && entry.every((item) => typeof item === "string")
      : field.type === "integer" ? Number.isSafeInteger(entry)
      : field.type === "number" ? typeof entry === "number" && Number.isFinite(entry)
      : typeof entry === field.type;
    if (!valid) { issue(key, "CONFIG_FIELD_TYPE_INVALID"); continue; }
    const enums: Record<string, string[]> = {
      "backend.tunnelAuth.scope": ["all", "forwarded"],
      "appServer.discovery": ["auto", "explicit", "disabled"],
      "logging.level": ["error", "warn", "info", "http", "verbose", "debug", "silly"],
      "terminal.tmux.shutdownPolicy": ["preserve", "cleanup"],
      "services.suiji.ai.provider": ["disabled", "codex-cli"],
      "services.feishu.legacyWebhook.transport": ["app", "webhook"],
    };
    if (enums[key] && !enums[key]!.includes(String(entry))) issue(key, "CONFIG_FIELD_ENUM_INVALID");
    if (["services.snapshotPublisher.url", "services.pushSender.gatewayURL"].includes(key) && typeof entry === "string") {
      try { const url = new URL(entry); if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(); }
      catch { issue(key, "CONFIG_SERVICE_ORIGIN_INVALID"); }
    }
    if (key === "services.feishu.legacyWebhook.url" && typeof entry === "string") {
      try { const url = new URL(entry); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(); }
      catch { issue(key, "CONFIG_SERVICE_ORIGIN_INVALID"); }
    }
    if (field.sensitive && typeof entry === "string" && ["<redacted>", "********"].includes(entry)) issue(key, "CONFIG_SECRET_VALUE_INVALID");
    if (typeof entry === "number" && (/port$/i.test(key) && (entry < 1 || entry > 65535) || /(?:TtlSeconds|timeoutMs|maxOutputBytes|Seconds|IntervalMs)$/.test(key) && entry <= 0 || /DelayMs$/.test(key) && entry < 0)) issue(key, "CONFIG_FIELD_RANGE_INVALID");
    const mutablePath = key.startsWith("storage.") || key === "logging.backendDirectory" || ["appServer.stateDirectory", "appServer.cloudSyncDirectory", "services.snapshotHost.directory", "services.pushGateway.directory", "services.suiji.storageDirectory"].includes(key);
    if (typeof entry === "string" && mutablePath) {
      try { if (!path.isAbsolute(entry)) throw new Error(); assertOwnedPath(context, entry); } catch { issue(key, "CONFIG_PATH_OUTSIDE_INSTANCE"); }
    }
  }
  for (const [domain, keys] of Object.entries({
    "backend.auth": ["username", "password", "jwtSecret"],
    "services.snapshotPublisher": ["url", "token"],
    "services.pushSender": ["gatewayURL", "senderToken", "hostId"],
    "services.feishu": ["appId", "appSecret"],
  })) {
    const fields = keys.map((key) => readConfigurationPath(value, `${domain}.${key}`));
    if (fields.some((entry) => entry !== null && entry !== undefined)) {
      const missing = fields.findIndex((entry) => typeof entry !== "string" || !entry.trim());
      if (missing >= 0) issue(`${domain}.${keys[missing]}`, "CONFIG_CREDENTIAL_GROUP_INCOMPLETE");
    }
  }
  const roles = readConfigurationPath(value, "agents.team.roles");
  if (isConfigurationObject(roles)) for (const [role, selection] of Object.entries(roles)) {
    const key = `agents.team.roles.${configurationPathSegment(role)}`;
    if (!isConfigurationObject(selection) || !["codex", "traex"].includes(String(selection.provider)) || typeof selection.model !== "string" || !selection.model.trim() || selection.provider === "codex" && (typeof selection.fast !== "boolean" || selection.max !== undefined) || selection.provider === "traex" && (typeof selection.max !== "boolean" || selection.fast !== undefined)) issue(key, "CONFIG_MODEL_SELECTION_INVALID");
  }
  for (const [domain, version] of Object.entries(value.domainVersions)) {
    if (version !== 1 && !result[domain]) result[domain] = [{ path: domain, code: "CONFIG_DOMAIN_VERSION_UNSUPPORTED" }];
  }
  return result;
}

export function redactConfiguration(value: ConfigurationObject): ConfigurationObject {
  const visit = (entry: ConfigurationValue, key: string): ConfigurationValue => {
    if (key === "migrations") return {};
    if (fieldForPath(key)?.sensitive) return { configured: typeof entry === "string" && entry.length > 0 };
    if (fieldForPath(key)?.type === "array<string>" && Array.isArray(entry) && entry.every((item) => typeof item === "string") || fieldForPath(key)?.type === "array<number>" && Array.isArray(entry) && entry.every((item) => typeof item === "number")) return entry;
    if (Array.isArray(entry)) return entry.map((item, i) => visit(item, `${key}.${i}`));
    if (isConfigurationObject(entry)) return Object.fromEntries(Object.entries(entry).map(([name, item]) => [name, visit(item, key ? `${key}.${configurationPathSegment(name)}` : configurationPathSegment(name))]));
    // Unknown future domains must not become a secret export channel.
    if (key && !fieldForPath(key) && !["schemaVersion", "revision", "kind", "instanceId"].includes(key) && !key.startsWith("domainVersions.")) return { configured: entry !== null };
    return entry;
  };
  return visit(value, "") as ConfigurationObject;
}
