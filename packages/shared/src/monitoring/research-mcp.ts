/** Persisted installation identity; contains paths, never credentials. */
export interface ResearchMcpInstallation {
  version: 1;
  instanceId: string;
  enabled: boolean;
  entry: string;
  node: string;
  cwd: string;
  port: number;
  releaseId: string;
  sourceRevision: string;
  installedAt: number;
  tunnel: {
    executable: string;
    profile: string;
    profileDir: string;
    healthFile: string;
  } | null;
}
