import {
  readConfigurationPath,
  type ConfigurationExplanation,
  type ConfigurationValue,
  type ConfigurationValueResolution,
} from "@runweave/shared/configuration";
import type { ConfigurationSnapshot } from "./store";
import { ConfigurationError } from "./errors";
import { domainForPath, fieldForPath } from "./validation";

/** Resolve without materializing defaults into the user's persisted document. */
export function resolveConfigurationValue(snapshot: ConfigurationSnapshot, key: string): ConfigurationValueResolution {
  if (snapshot.issues[domainForPath(key)]?.length) return { source: "invalid" };
  const saved = readConfigurationPath(snapshot.value, key);
  // null retains the existing reset-to-default contract; other falsy values are explicit.
  if (saved !== undefined && saved !== null) return { source: "saved", value: structuredClone(saved) };
  const field = fieldForPath(key);
  if (!field) return { source: "unset" };
  if ("rule" in field.default) return { source: "consumerDefault" };
  if (field.default.value === null) return { source: "unset" };
  return { source: "default", value: structuredClone(field.default.value) };
}

/** A disk explanation is not evidence that another process adopted the value. */
export function explainConfigurationValue(snapshot: ConfigurationSnapshot, key: string): ConfigurationExplanation {
  const field = fieldForPath(key);
  if (!field) throw new ConfigurationError("CONFIG_FIELD_UNKNOWN", [key]);
  const publicValue = (value: ConfigurationValue | undefined): ConfigurationValue | undefined =>
    field.sensitive ? { configured: typeof value === "string" && value.length > 0 } : value;
  const resolved = resolveConfigurationValue(snapshot, key);
  return {
    path: key, domain: field.domain, owner: field.owner, apply: field.apply,
    default: "value" in field.default ? { value: publicValue(field.default.value)! } : field.default,
    savedValue: publicValue(readConfigurationPath(snapshot.value, key)),
    resolved: { ...resolved, value: publicValue(resolved.value) },
    issues: snapshot.issues[domainForPath(key)] ?? [],
    application: "notObserved",
  };
}
