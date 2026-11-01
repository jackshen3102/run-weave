import type { ConfigurationStatus } from "./configuration/types";

export type ServerConfigurationObservation = Pick<ConfigurationStatus, "savedRevision" | "digest" | "diskError" | "consumers">;
export const SERVER_CLI_CAPABILITIES = { configurationUpgrade: 1, updateDryRun: true } as const;

/** Local installation management; independent of web login credentials. */
export interface ServerMaintenanceLease {
  leaseId: string;
  expiresAt: string;
  affectedRuns: { runId: string; reason: string }[];
}

export interface ServerReleaseManifest {
  schemaVersion: 1;
  managementApiVersion: 1;
  version: string;
  sourceRevision: string;
  platform: string;
  arch: string;
  nodeModuleAbi: string;
  sqlitePrebuild: string;
  /** Same fingerprint means the persisted schema/migration contract is unchanged. */
  dataCompatibility: string;
  /** Version 1 separates database schema protection from configuration migration. */
  configurationUpgradeVersion?: 1;
  databaseCompatibility?: string;
  /** Legacy combined fingerprints, computed with the same database sources. */
  legacyDataCompatibility?: string[];
  files: { path: string; sha256: string; size: number }[];
}
