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
}

export function ConnectionsPage({
  connections,
  activeId,
  onAdd,
  onRemove,
  onSelect,
  onEdit,
}: ConnectionsPageProps) {
  const navigate = useNavigate();

  return (
    <ConnectionScreen
      connections={connections}
      activeId={activeId}
      onAdd={(name, url) => {
        onAdd(name, url);
        navigate("/login", { replace: true });
      }}
      onRemove={onRemove}
      onSelect={(id) => {
        onSelect(id);
        navigate("/login", { replace: true });
      }}
      onEdit={onEdit}
    />
  );
}
