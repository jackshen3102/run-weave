import { Navigate, useParams } from "react-router-dom";
import { TerminalWorkspace } from "../components/terminal/terminal-workspace";

interface TerminalRoutePageProps {
  apiBase: string;
  token: string;
  onAuthExpired: () => void;
}

export function TerminalRoutePage({
  apiBase,
  token,
  onAuthExpired,
}: TerminalRoutePageProps) {
  const { terminalSessionId } = useParams<{ terminalSessionId: string }>();

  if (!terminalSessionId) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="h-dvh overflow-hidden bg-slate-950 p-3">
      <TerminalWorkspace
        apiBase={apiBase}
        token={token}
        initialTerminalSessionId={terminalSessionId}
        onAuthExpired={onAuthExpired}
      />
    </main>
  );
}
