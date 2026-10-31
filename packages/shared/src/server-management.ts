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
  files: { path: string; sha256: string; size: number }[];
}
