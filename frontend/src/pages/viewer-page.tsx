import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ViewerPage as ViewerScreen } from "../components/viewer-page";
import type { ClientMode } from "../features/client-mode";

interface ViewerPageProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  onAuthExpired: () => void;
}

export function ViewerPage({
  apiBase,
  token,
  clientMode,
  onAuthExpired,
}: ViewerPageProps) {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();

  if (!sessionId) {
    return <Navigate to="/" replace />;
  }

  return (
    <ViewerScreen
      apiBase={apiBase}
      sessionId={sessionId}
      token={token}
      clientMode={clientMode}
      onAuthExpired={onAuthExpired}
      onHome={() => {
        navigate("/", { replace: true });
      }}
    />
  );
}
