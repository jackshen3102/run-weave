import type { Document } from "yaml";
import {
  CONFIGURATION_DOMAIN_VERSIONS, CONFIGURATION_SCHEMA_VERSION,
  type ConfigurationFile,
} from "@runweave/shared/configuration";
import { ConfigurationError } from "./errors";

export interface ConfigurationVersionMigration {
  id: string;
  /** Omit domain for an envelope migration. Steps may change only their domain. */
  domain?: string;
  from: number;
  to: number;
  migrate(document: Document): void;
}

// Append immutable steps here when a release changes a configuration version.
// These functions ship in the executable; never load migration code from settings.
export const CONFIGURATION_VERSION_MIGRATIONS: readonly ConfigurationVersionMigration[] = [];

export function migrateConfigurationDocument(document: Document): string[] {
  const steps: string[] = [];
  const ids = new Set<string>();
  const edges = new Set<string>();
  for (const step of CONFIGURATION_VERSION_MIGRATIONS) {
    const edge = `${step.domain ?? "$schema"}:${step.from}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(step.id) || ids.has(step.id) || edges.has(edge)
      || !Number.isSafeInteger(step.from) || step.from < 1 || step.to !== step.from + 1
      || step.domain !== undefined && !Object.hasOwn(CONFIGURATION_DOMAIN_VERSIONS, step.domain)
      || step.to > (step.domain ? CONFIGURATION_DOMAIN_VERSIONS[step.domain]! : CONFIGURATION_SCHEMA_VERSION)) {
      throw new ConfigurationError("CONFIG_UPGRADE_REGISTRY_INVALID");
    }
    ids.add(step.id); edges.add(edge);
  }
  const advance = (domain: string | undefined, target: number) => {
    const versionPath = domain ? ["domainVersions", domain] : ["schemaVersion"];
    let version = Number(document.getIn(versionPath) ?? 1);
    if (version > target) throw new ConfigurationError("CONFIG_UPGRADE_FUTURE_VERSION", [domain ?? "schemaVersion"]);
    while (version < target) {
      const step = CONFIGURATION_VERSION_MIGRATIONS.find(item => item.domain === domain && item.from === version);
      if (!step) throw new ConfigurationError("CONFIG_UPGRADE_PATH_MISSING", [domain ?? "schemaVersion"]);
      const before = document.toJS() as ConfigurationFile;
      try { step.migrate(document); } catch { throw new ConfigurationError("CONFIG_UPGRADE_STEP_FAILED", [step.id]); }
      const after = document.toJS() as ConfigurationFile;
      for (const key of ["schemaVersion", "revision", "kind", "instanceId", "domainVersions", "migrations"] as const) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new ConfigurationError("CONFIG_UPGRADE_METADATA_CHANGED", [step.id]);
      }
      if (domain) {
        const strip = (value: ConfigurationFile) => {
          const copy = structuredClone(value);
          const parts = domain.split(".");
          let parent: Record<string, unknown> = copy;
          for (const key of parts.slice(0, -1)) parent = (parent[key] ?? {}) as Record<string, unknown>;
          delete parent[parts.at(-1)!];
          return copy;
        };
        if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) throw new ConfigurationError("CONFIG_UPGRADE_SCOPE_CHANGED", [step.id]);
      }
      document.setIn(versionPath, step.to);
      document.setIn(["migrations", `version:${step.id}`], { from: step.from, to: step.to, domain: domain ?? "$schema" });
      steps.push(step.id);
      version = step.to;
    }
  };
  advance(undefined, CONFIGURATION_SCHEMA_VERSION);
  for (const [domain, target] of Object.entries(CONFIGURATION_DOMAIN_VERSIONS)) advance(domain, target);
  return steps;
}
