export interface ConnectionConfig {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  tunnelEndpointId?: string;
  tunnelHostId?: string;
  browserProfileId?: "profile-1" | "profile-2" | "profile-3" | null;
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
