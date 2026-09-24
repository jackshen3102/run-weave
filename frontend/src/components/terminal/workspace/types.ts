import type { ConnectionConfig } from "../../../features/connection/types";
import type { ClientMode } from "../../../features/client-mode";

export interface TerminalWorkspaceConnectionOptions {
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  remote?: { generation: number; browserProfileId: "profile-1" | "profile-2" | "profile-3" | null } | null;
}

export interface TerminalWorkspaceProps {
  apiBase: string;
  token: string;
  clientMode?: ClientMode;
  connection?: TerminalWorkspaceConnectionOptions;
  initialTerminalSessionId?: string;
  onActiveSessionChange?: (terminalSessionId: string | null) => void;
  onNoSessionAvailable?: () => void;
  onNavigateHome?: () => void;
  onAuthExpired?: () => void;
  className?: string;
}
