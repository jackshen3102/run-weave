import type { ConnectionConfig } from "../../../features/connection/types";
import { ConnectionSwitcher } from "../../../components/connection-switcher";
import { RuntimeMonitorBadge } from "../../../components/runtime-monitor-badge";
import { ThemeToggle } from "../../../components/theme-toggle";
import { Button } from "../../../components/ui/button";
import { Activity } from "lucide-react";

interface HomeHeaderProps {
  terminalLoading: boolean;
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  onOpenTerminal: () => void;
  onOpenSystemMonitor?: () => void;
  onOpenChangePassword: () => void;
  onLogout: () => void;
}

export function HomeHeader({
  terminalLoading,
  connections = [],
  activeConnectionId = null,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
  onOpenTerminal,
  onOpenSystemMonitor,
  onOpenChangePassword,
  onLogout,
}: HomeHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
          Runweave
        </p>
        {connectionName && onSelectConnection && onOpenConnectionManager && (
          <ConnectionSwitcher
            connections={connections}
            activeConnectionId={activeConnectionId}
            activeConnectionName={connectionName}
            onSelectConnection={onSelectConnection}
            onOpenConnectionManager={onOpenConnectionManager}
          />
        )}
        {connectionName &&
          (!onSelectConnection || !onOpenConnectionManager) && (
            <span className="rounded-full border border-border/60 bg-background/60 px-3 py-1 text-[0.65rem] text-muted-foreground">
              {connectionName}
            </span>
          )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="rounded-full px-4"
          onClick={onOpenTerminal}
          disabled={terminalLoading}
        >
          {terminalLoading ? "Opening..." : "Open Terminal"}
        </Button>
        {onOpenSystemMonitor ? (
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full px-4"
            onClick={onOpenSystemMonitor}
          >
            <Activity className="mr-2 h-4 w-4" />
            System Monitor
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-4 text-muted-foreground"
          onClick={onOpenChangePassword}
        >
          Change Password
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-4 text-muted-foreground"
          onClick={onLogout}
        >
          Logout
        </Button>
        <RuntimeMonitorBadge />
        <ThemeToggle />
      </div>
    </header>
  );
}
