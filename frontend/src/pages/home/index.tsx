import { useMemoizedFn } from "ahooks";
import { useNavigate } from "react-router-dom";
import { Activity } from "lucide-react";
import { RuntimeMonitorBadge } from "../../components/runtime-monitor-badge";
import { Button } from "../../components/ui/button";
import { ChangePasswordDialog } from "./components/change-password-dialog";
import { HomeHeader } from "./components/home-header";
import { useHomeTerminalPassword } from "./hooks/use-home-terminal-password";
import type { ClientMode } from "../../features/client-mode";

interface HomePageProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  clearToken: () => void;
  connections?: Array<{
    id: string;
    name: string;
    url: string;
    createdAt: number;
    isSystem?: boolean;
    canEdit?: boolean;
    canDelete?: boolean;
  }>;
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
}

export function HomePage({
  apiBase,
  token,
  clientMode,
  clearToken,
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
}: HomePageProps) {
  const navigate = useNavigate();
  const handleAuthExpired = useMemoizedFn(() => {
    clearToken();
    navigate("/login", { replace: true });
  });

  const {
    terminalLoading,
    terminalError,
    createTerminal,
    passwordDialogOpen,
    passwordChangeLoading,
    passwordChangeError,
    openPasswordDialog,
    closePasswordDialog,
    changePassword,
  } = useHomeTerminalPassword({
    apiBase,
    token,
    clientMode,
    onAuthExpired: handleAuthExpired,
    onOpenTerminalSession: (terminalSessionId) => {
      navigate(`/terminal/${encodeURIComponent(terminalSessionId)}`);
    },
  });

  const openTerminal = () => {
    void createTerminal();
  };
  const canOpenSystemMonitor = window.electronAPI?.isElectron === true;
  const openSystemMonitor = canOpenSystemMonitor
    ? () => {
        navigate("/system-monitor");
      }
    : undefined;
  const openActivity = () => navigate("/activity");

  if (clientMode === "mobile") {
    return (
      <main className="relative min-h-dvh overflow-hidden px-4 py-5">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.68),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(68,136,146,0.14),transparent_30%)]" />
        <div className="relative mx-auto flex min-h-[calc(100dvh-2.5rem)] w-full max-w-2xl flex-col gap-5">
          <header className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.34em] text-muted-foreground/70">
                Runweave
              </p>
              {connectionName ? (
                <p className="mt-2 truncate text-sm text-muted-foreground">
                  {connectionName}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {openSystemMonitor ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full px-3"
                  onClick={openSystemMonitor}
                >
                  <Activity className="h-4 w-4" />
                  <span className="sr-only">System Monitor</span>
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full px-3"
                onClick={openActivity}
              >
                <Activity className="h-4 w-4" />
                <span className="sr-only">Activity Facts</span>
              </Button>
              <Button
                size="sm"
                className="rounded-full px-4"
                onClick={openTerminal}
                disabled={terminalLoading}
              >
                {terminalLoading ? "Opening..." : "Terminal"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full px-4 text-muted-foreground"
                onClick={handleAuthExpired}
              >
                Logout
              </Button>
            </div>
          </header>
          <RuntimeMonitorBadge />

          {terminalError ? (
            <p className="text-sm text-red-500" role="alert">
              {terminalError}
            </p>
          ) : null}

          <section className="flex flex-1 flex-col justify-center rounded-[1.5rem] border border-border/60 bg-card/82 p-5 shadow-[0_26px_100px_-72px_rgba(17,24,39,0.7)] backdrop-blur-xl">
            <div className="space-y-4">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/70">
                Workspace
              </p>
              <p className="max-w-sm text-2xl font-semibold text-foreground">
                Open a terminal session to continue.
              </p>
              <Button
                className="h-11 rounded-full px-6"
                onClick={openTerminal}
                disabled={terminalLoading}
              >
                {terminalLoading ? "Opening..." : "Open Terminal"}
              </Button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 md:px-6 md:py-8 xl:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.75),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(68,136,146,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,166,122,0.18),transparent_28%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col gap-8">
        <HomeHeader
          terminalLoading={terminalLoading}
          connections={connections}
          activeConnectionId={activeConnectionId}
          connectionName={connectionName}
          onSelectConnection={onSelectConnection}
          onOpenConnectionManager={onOpenConnectionManager}
          onOpenTerminal={openTerminal}
          onOpenSystemMonitor={openSystemMonitor}
          onOpenActivity={openActivity}
          onOpenChangePassword={openPasswordDialog}
          onLogout={handleAuthExpired}
        />
        <ChangePasswordDialog
          open={passwordDialogOpen}
          loading={passwordChangeLoading}
          error={passwordChangeError}
          onClose={closePasswordDialog}
          onSubmit={changePassword}
        />

        {terminalError ? (
          <p className="text-sm text-red-500" role="alert">
            {terminalError}
          </p>
        ) : null}

        <section className="flex flex-1 items-center rounded-[2rem] border border-border/60 bg-card/75 p-8 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl">
          <div className="max-w-2xl space-y-6">
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
              Workspace
            </p>
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold text-foreground">
                Open a terminal session to continue.
              </h1>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                className="h-11 rounded-full px-6"
                onClick={openTerminal}
                disabled={terminalLoading}
              >
                {terminalLoading ? "Opening..." : "Open Terminal"}
              </Button>
              {openSystemMonitor ? (
                <Button
                  variant="secondary"
                  className="h-11 rounded-full px-6"
                  onClick={openSystemMonitor}
                >
                  <Activity className="mr-2 h-4 w-4" />
                  System Monitor
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
