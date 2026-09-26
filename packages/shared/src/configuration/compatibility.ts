import { CONFIGURATION_FIELDS } from "./fields";
import type { ConfigurationFile } from "./types";

/** Published with executable artifacts, never inferred from an app version. */
export const CONFIGURATION_COMPATIBILITY = {
  format: "runweave-yaml",
  schemaVersions: [1],
  domainVersions: Object.fromEntries([...new Set(CONFIGURATION_FIELDS.map(field => field.domain))].map(domain => [domain, [1]])),
};

/** App Server does not consume Desktop or Backend service configuration. */
export const APP_SERVER_CONFIGURATION_COMPATIBILITY = {
  ...CONFIGURATION_COMPATIBILITY,
  domainVersions: Object.fromEntries(["appServer", "agents.codex", "agents.traex"].map(domain => [domain, [1]])),
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
