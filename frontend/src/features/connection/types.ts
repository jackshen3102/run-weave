export interface ConnectionConfig {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  isSystem?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface ConnectionStore {
  connections: ConnectionConfig[];
  activeId: string | null;
}
