import { ThemeToggle } from "../../../components/theme-toggle";
import { Button } from "../../../components/ui/button";

interface HomeHeaderProps {
  sessionCount: number;
  terminalLoading: boolean;
  connectionName?: string;
  onSwitchConnection?: () => void;
  onOpenSessions: () => void;
  onOpenTerminal: () => void;
  onLogout: () => void;
}

export function HomeHeader({
  sessionCount,
  terminalLoading,
  connectionName,
  onSwitchConnection,
  onOpenSessions,
  onOpenTerminal,
  onLogout,
}: HomeHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
          Browser Viewer
        </p>
        {connectionName && onSwitchConnection && (
          <button
            type="button"
            className="rounded-full border border-border/60 bg-background/60 px-3 py-1 text-[0.65rem] text-muted-foreground transition hover:bg-muted/72"
            onClick={onSwitchConnection}
          >
            {connectionName} ↗
          </button>
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
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full border border-border/60 bg-background/60 px-4 backdrop-blur"
          onClick={onOpenSessions}
        >
          Sessions{sessionCount > 0 ? ` ${sessionCount}` : ""}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-4 text-muted-foreground"
          onClick={onLogout}
        >
          Logout
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}
