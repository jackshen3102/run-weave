import { CONFIGURATION_FIELDS } from "./fields";
import type { ConfigurationFile } from "./types";

export const CONFIGURATION_SCHEMA_VERSION: number = 1;
export const CONFIGURATION_DOMAIN_VERSIONS: Record<string, number> = Object.fromEntries(
  [...new Set(CONFIGURATION_FIELDS.map(field => field.domain))].map(domain => [domain, 1]),
);

/** Published with executable artifacts, never inferred from an app version. */
export const CONFIGURATION_COMPATIBILITY = {
  format: "runweave-yaml",
  schemaVersions: [CONFIGURATION_SCHEMA_VERSION],
  domainVersions: Object.fromEntries(Object.entries(CONFIGURATION_DOMAIN_VERSIONS).map(([domain, version]) => [domain, [version]])),
};

/** App Server does not consume Desktop or Backend service configuration. */
export const APP_SERVER_CONFIGURATION_COMPATIBILITY = {
  ...CONFIGURATION_COMPATIBILITY,
  domainVersions: Object.fromEntries(["appServer", "agents.codex", "agents.traex", "agents.claude"].map(domain => [domain, [CONFIGURATION_DOMAIN_VERSIONS[domain]!]])),
};

export function supportsConfiguration(target: unknown, value: Pick<ConfigurationFile, "schemaVersion" | "domainVersions">): boolean {
  if (!target || typeof target !== "object") return false;
  const capability = target as Partial<typeof CONFIGURATION_COMPATIBILITY>;
  if (capability.format !== "runweave-yaml" || !Array.isArray(capability.schemaVersions) || !capability.schemaVersions.includes(value.schemaVersion)) return false;
  if (!capability.domainVersions || typeof capability.domainVersions !== "object" || Array.isArray(capability.domainVersions)) return false;
  // Unknown domains belong to other consumers and remain opaque. A target
  // must understand the saved version of each domain it declares it consumes.
  return Object.entries(capability.domainVersions).every(([domain, versions]) => Array.isArray(versions) && versions.includes(value.domainVersions[domain] ?? 1));
}
