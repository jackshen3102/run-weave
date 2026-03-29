import { Navigate, useParams } from "react-router-dom";
import { TerminalPage as TerminalScreen } from "../components/terminal-page";

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
    <TerminalScreen
      apiBase={apiBase}
      terminalSessionId={terminalSessionId}
      token={token}
      onAuthExpired={onAuthExpired}
    />
  );
}
