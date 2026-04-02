export interface ConnectionConfig {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

export interface ConnectionStore {
  connections: ConnectionConfig[];
  activeId: string | null;
}
