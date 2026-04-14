import { Navigate, useNavigate, useParams } from "react-router-dom";
import { TerminalWorkspace } from "../components/terminal/terminal-workspace";
import type { ClientMode } from "../features/client-mode";

interface TerminalRoutePageProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  onAuthExpired: () => void;
}

export function TerminalRoutePage({
  apiBase,
  token,
  clientMode,
  onAuthExpired,
}: TerminalRoutePageProps) {
  const { terminalSessionId } = useParams<{ terminalSessionId: string }>();
  const navigate = useNavigate();

  if (!terminalSessionId) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="h-dvh overflow-hidden bg-slate-950 px-3 pt-3 pb-2">
      <TerminalWorkspace
        apiBase={apiBase}
        token={token}
        clientMode={clientMode}
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
          navigate("/", { replace: true });
        }}
        onNavigateHome={() => {
          navigate("/");
        }}
        onAuthExpired={onAuthExpired}
      />
    </main>
  );
}
