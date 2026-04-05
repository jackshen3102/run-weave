import { useNavigate } from "react-router-dom";
import type { ConnectionConfig } from "../features/connection/types";
import { LoginPage as LoginScreen } from "../components/login-page";
import type { LoginResponse } from "@browser-viewer/shared";

interface LoginPageProps {
  apiBase: string;
  connectionId?: string;
  isElectron?: boolean;
  connections?: ConnectionConfig[];
  connectionName?: string;
  onSwitchConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  onSuccess: (session: LoginResponse) => void;
}

export function LoginPage({
  apiBase,
  connectionId,
  isElectron,
  connections,
  connectionName,
  onSwitchConnection,
  onOpenConnectionManager,
  onSuccess,
}: LoginPageProps) {
  const navigate = useNavigate();

  return (
    <LoginScreen
      apiBase={apiBase}
      connectionId={connectionId}
      isElectron={isElectron}
      connections={connections}
      connectionName={connectionName}
      onSwitchConnection={onSwitchConnection}
      onOpenConnectionManager={onOpenConnectionManager}
      onSuccess={(session) => {
        onSuccess(session);
        navigate("/", { replace: true });
      }}
    />
  );
}
