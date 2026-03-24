import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ViewerPage as ViewerScreen } from "../components/viewer-page";

interface ViewerPageProps {
  apiBase: string;
  token: string;
  onAuthExpired: () => void;
}

export function ViewerPage({
  apiBase,
  token,
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
      onAuthExpired={onAuthExpired}
      onHome={() => {
        navigate("/", { replace: true });
      }}
    />
  );
}
