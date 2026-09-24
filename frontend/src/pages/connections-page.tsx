import { useNavigate } from "react-router-dom";
import { ConnectionPage as ConnectionScreen } from "../components/connection-page";
import type { ConnectionConfig } from "../features/connection/types";

interface ConnectionsPageProps {
  connections: ConnectionConfig[];
  activeId: string | null;
  onAdd: (name: string, url: string) => void;
  onAddRemote: (name: string, host: string, backendPort: number, browserProfileId: "profile-1" | "profile-2" | "profile-3" | null, approvedBrowserGroupId: string | null) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: { name?: string; url?: string }) => void;
  onReconnect?: (id: string) => Promise<boolean>;
}

export function ConnectionsPage({
  connections,
  activeId,
  onAdd,
  onAddRemote,
  onRemove,
  onSelect,
  onEdit,
  onReconnect,
}: ConnectionsPageProps) {
  const navigate = useNavigate();

  return (
    <>
    <ConnectionScreen
      connections={connections}
      activeId={activeId}
      onAdd={(name, url) => {
        onAdd(name, url);
        navigate("/terminal", { replace: true });
      }}
      onAddRemote={(name, host, backendPort, browserProfileId, approvedBrowserGroupId) => {
        onAddRemote(name, host, backendPort, browserProfileId, approvedBrowserGroupId);
      }}
      onRemove={onRemove}
      onSelect={(id) => {
        onSelect(id);
        navigate("/terminal", { replace: true });
      }}
      onEdit={onEdit}
      onReconnect={async (id) => {
        const reconnected = await onReconnect?.(id);
        if (reconnected) {
          onSelect(id);
          navigate("/terminal", { replace: true });
          return true;
        }

        return false;
      }}
      onForwardPort={(id, remotePort) => window.electronAPI!.forwardRemotePort!(id, remotePort)}
    />
    </>
  );
}
