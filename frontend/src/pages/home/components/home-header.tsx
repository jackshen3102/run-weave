import { ThemeToggle } from "../../../components/theme-toggle";
import { Button } from "../../../components/ui/button";

interface HomeHeaderProps {
  sessionCount: number;
  onOpenSessions: () => void;
  onLogout: () => void;
}

export function HomeHeader({
  sessionCount,
  onOpenSessions,
  onLogout,
}: HomeHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
          Browser Viewer
        </p>
      </div>
      <div className="flex items-center gap-2">
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
