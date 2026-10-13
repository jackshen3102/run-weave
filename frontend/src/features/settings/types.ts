import type { ConnectionConfig } from "../connection/types";
import type { SettingsAuth } from "./target-context";
export interface SettingsPageProps {
  connections: ConnectionConfig[];
  activeConnection: ConnectionConfig | undefined;
  workspaceAuth: SettingsAuth;
  webApiBase: string;
  onAdd: (name: string, url: string, endpointId?: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string, patch: { name?: string; url?: string }) => void;
  onReconnect: (id: string) => Promise<boolean>;
}
