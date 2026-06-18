export interface AppConnectionConfig {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  available?: boolean;
  statusMessage?: string | null;
  isDefault?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface AppConnectionStore {
  connections: AppConnectionConfig[];
  activeId: string | null;
}
