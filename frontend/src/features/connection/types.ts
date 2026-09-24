export interface ConnectionConfig {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  kind?: "ssh";
  sshHost?: string;
  sshBackendPort?: number;
  browserProfileId?: "profile-1" | "profile-2" | "profile-3" | null;
  approvedBrowserGroupId?: string | null;
  generation?: number;
  browserAvailable?: boolean;
  browserMessage?: string | null;
  remoteStatus?: "disconnected" | "connecting" | "ready" | "reconnecting" | "needs_auth" | "incompatible" | "failed";
  installationId?: string | null;
  available?: boolean;
  statusMessage?: string | null;
  canReconnect?: boolean;
  runtimeSource?: "external" | "bundled" | null;
  runtimeReleaseId?: string | null;
  isSystem?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface ConnectionStore {
  connections: ConnectionConfig[];
  activeId: string | null;
}
