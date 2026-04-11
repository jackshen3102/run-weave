export interface ConnectionConfig {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  available?: boolean;
  statusMessage?: string | null;
  canReconnect?: boolean;
  isSystem?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface ConnectionStore {
  connections: ConnectionConfig[];
  activeId: string | null;
}
