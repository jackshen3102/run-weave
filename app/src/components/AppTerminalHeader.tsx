import { AppMoreMenu, type AppMoreMenuItem } from "./AppMoreMenu";

interface AppTerminalHeaderProps {
  connectionStatus: string;
  lastActivityAt?: string | null;
  moreMenuItems: AppMoreMenuItem[];
  onBack: () => void;
  onRefresh: () => void;
  statusLabel: string;
  subtitle: string;
  terminalSessionId: string;
  title: string;
  formatRelativeTime: (value: string) => string;
}

export function AppTerminalHeader({
  connectionStatus,
  formatRelativeTime,
  lastActivityAt,
  moreMenuItems,
  onBack,
  onRefresh,
  statusLabel,
  subtitle,
  terminalSessionId,
  title,
}: AppTerminalHeaderProps) {
  return (
    <header className="terminal-page-header border-border bg-card">
      <button
        aria-label="Back"
        className="terminal-page-header__button terminal-page-header__back"
        type="button"
        onClick={onBack}
      >
        <span aria-hidden="true" className="terminal-page-header__icon">
          ‹
        </span>
      </button>
      <div className="terminal-page-header__identity min-w-0">
        <div className="terminal-page-header__title-row">
          <h1 className="text-foreground">{title}</h1>
          <div className="terminal-page-header__meta text-muted-foreground">
            <span
              className={`terminal-page-header__status is-${connectionStatus}`}
            >
              {statusLabel}
            </span>
            {lastActivityAt ? (
              <time dateTime={lastActivityAt}>
                {formatRelativeTime(lastActivityAt)}
              </time>
            ) : null}
          </div>
        </div>
        <p className="text-muted-foreground">{subtitle || terminalSessionId}</p>
      </div>
      <button
        aria-label="Refresh terminal"
        className="terminal-page-header__button terminal-page-header__action"
        type="button"
        onClick={onRefresh}
      >
        <span aria-hidden="true" className="terminal-page-header__icon">
          ↻
        </span>
      </button>
      <AppMoreMenu
        ariaLabel="Terminal more actions"
        className="terminal-page-header__more"
        items={moreMenuItems}
      />
    </header>
  );
}
