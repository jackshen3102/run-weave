import { Button } from "../ui/button";

interface ViewerHeaderProps {
  sessionId: string;
  status: string;
  canReconnect: boolean;
  onReconnect: () => void;
  onBack: () => void;
}

export function ViewerHeader({
  sessionId,
  status,
  canReconnect,
  onReconnect,
  onBack,
}: ViewerHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold">Live Viewer</h1>
        <p className="text-sm text-muted-foreground">Session: {sessionId}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Status: {status}</span>
        {canReconnect && (
          <Button variant="secondary" size="sm" onClick={onReconnect}>
            Reconnect
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>
    </header>
  );
}
