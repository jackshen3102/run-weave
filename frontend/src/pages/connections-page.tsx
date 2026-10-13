import { useNavigate } from "react-router-dom";
import { ConnectionPage as ConnectionScreen } from "../components/connection-page";
import type { ConnectionConfig } from "../features/connection/types";

interface ConnectionsPageProps {
  embedded?: boolean;
  connections: ConnectionConfig[];
  activeId: string | null;
  onAdd: (name: string, url: string, tunnelEndpointId?: string) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: { name?: string; url?: string }) => void;
  onReconnect?: (id: string) => Promise<boolean>;
}

export function ConnectionsPage({
  embedded = false,
  connections,
  activeId,
  onAdd,
  onRemove,
  onSelect,
  onEdit,
  onReconnect,
}: ConnectionsPageProps) {
  const navigate = useNavigate();

  return (
    <>
    <ConnectionScreen embedded={embedded}
      connections={connections}
      activeId={activeId}
      onAdd={(name, url, endpointId) => {
        onAdd(name, url, endpointId);
        if (!embedded) navigate("/terminal", { replace: true });
      }}
      onRemove={onRemove}
      onSelect={(id) => {
        onSelect(id);
        if (!embedded) navigate("/terminal", { replace: true });
      }}
      onEdit={onEdit}
      onReconnect={async (id) => {
        const reconnected = await onReconnect?.(id);
        if (reconnected) {
          onSelect(id);
          if (!embedded) navigate("/terminal", { replace: true });
          return true;
        }

        return false;
      }}
    />
    </>
  );
}
