import { useNavigate, useParams } from "react-router-dom";
import { TerminalWorkspace } from "../components/terminal/terminal-workspace";
import type { ClientMode } from "../features/client-mode";
import type { ConnectionConfig } from "../features/connection/types";

interface TerminalRoutePageProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  onAuthExpired: () => void;
}

export function TerminalRoutePage({
  apiBase,
  token,
  clientMode,
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
  onAuthExpired,
}: TerminalRoutePageProps) {
  const { terminalSessionId } = useParams<{ terminalSessionId: string }>();
  const navigate = useNavigate();

  return (
    <main className="h-dvh overflow-hidden bg-slate-950">
      <TerminalWorkspace
        apiBase={apiBase}
        token={token}
        clientMode={clientMode}
        connections={connections}
        activeConnectionId={activeConnectionId}
        connectionName={connectionName}
        onSelectConnection={onSelectConnection}
        onOpenConnectionManager={onOpenConnectionManager}
        initialTerminalSessionId={terminalSessionId}
        onActiveSessionChange={(activeTerminalSessionId) => {
          if (activeTerminalSessionId === terminalSessionId) {
            return;
          }

          navigate(`/terminal/${encodeURIComponent(activeTerminalSessionId)}`, {
            replace: true,
          });
        }}
        onNoSessionAvailable={() => {
          if (terminalSessionId) {
            navigate("/terminal", { replace: true });
          }
        }}
        onNavigateHome={() => {
          navigate("/");
        }}
        onAuthExpired={onAuthExpired}
      />
    </main>
  );
}
