import { useNavigate, useParams } from "react-router-dom";
import { TerminalWorkspace } from "../components/terminal/workspace/workspace";
import type { ClientMode } from "../features/client-mode";
import type { ConnectionConfig } from "../features/connection/types";

interface TerminalRoutePageProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  activeConnection?: ConnectionConfig | null;
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
  activeConnection,
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
        connection={{
          activeConnectionId,
          connectionName,
          remote: activeConnection?.tunnelEndpointId ? {
            endpointId: activeConnection.tunnelEndpointId,
            generation: activeConnection.generation ?? 0,
            browserProfileId: activeConnection.browserProfileId ?? null,
          } : null,
          connections,
          onOpenConnectionManager,
          onSelectConnection,
        }}
        initialTerminalSessionId={terminalSessionId}
        onActiveSessionChange={(activeTerminalSessionId) => {
          if (activeTerminalSessionId === terminalSessionId) {
            return;
          }
          navigate(activeTerminalSessionId ? `/terminal/${encodeURIComponent(activeTerminalSessionId)}` : "/terminal", {
            replace: true,
          });
        }}
        onNoSessionAvailable={() => {
          if (terminalSessionId) {
            navigate("/terminal", { replace: true });
          }
        }}
        onNavigateHome={() => {
          navigate("/home");
        }}
        onAuthExpired={onAuthExpired}
      />
    </main>
  );
}
