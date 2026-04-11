import { useNavigate } from "react-router-dom";
import { ConnectionPage as ConnectionScreen } from "../components/connection-page";
import type { ConnectionConfig } from "../features/connection/types";

interface ConnectionsPageProps {
  connections: ConnectionConfig[];
  activeId: string | null;
  onAdd: (name: string, url: string) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: { name?: string; url?: string }) => void;
  onReconnect?: (id: string) => Promise<boolean>;
}

export function ConnectionsPage({
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
    <ConnectionScreen
      connections={connections}
      activeId={activeId}
      onAdd={(name, url) => {
        onAdd(name, url);
        navigate("/", { replace: true });
      }}
      onRemove={onRemove}
      onSelect={(id) => {
        onSelect(id);
        navigate("/", { replace: true });
      }}
      onEdit={onEdit}
      onReconnect={async (id) => {
        const reconnected = await onReconnect?.(id);
        if (reconnected) {
          onSelect(id);
          navigate("/", { replace: true });
          return true;
        }

        return false;
      }}
    />
  );
}
