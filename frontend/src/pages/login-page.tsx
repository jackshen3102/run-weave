import { SuijiEntryLink } from "../features/suiji/entry-link";
import { useNavigate } from "react-router-dom";
import type { ConnectionConfig } from "../features/connection/types";
import { LoginPage as LoginScreen } from "../components/login-page";
import type { LoginResponse } from "@runweave/shared/protocol";

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
    <>
    <SuijiEntryLink className="fixed bottom-6 left-6 z-10 rounded-full border bg-card px-4 py-2 text-sm text-foreground shadow-sm">打开随记</SuijiEntryLink>
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
        navigate("/terminal", { replace: true });
      }}
    />
    </>
  );
}
