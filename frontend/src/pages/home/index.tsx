import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { HomeHeader } from "./components/home-header";
import { ChangePasswordDialog } from "./components/change-password-dialog";
import { HomeSidebar } from "./components/home-sidebar";
import { SessionList } from "./components/session-list";
import { useHomeSessions } from "./hooks/use-home-sessions";
import { useHomeTerminalPassword } from "./hooks/use-home-terminal-password";

interface HomePageProps {
  apiBase: string;
  token: string;
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
  clearToken,
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
}: HomePageProps) {
  const navigate = useNavigate();
  const handleAuthExpired = useCallback(() => {
    clearToken();
    navigate("/login", { replace: true });
  }, [clearToken, navigate]);

  const {
    sessionSourceType,
    setSessionSourceType,
    sessionName,
    setSessionName,
    proxyEnabled,
    setProxyEnabled,
    cdpEndpoint,
    defaultCdpEndpoint,
    setCdpEndpoint,
    requestHeadersInput,
    setRequestHeadersInput,
    preferredForAi,
    setPreferredForAi,
    loading,
    error,
    sortedSessions,
    loadingSessions,
    openingAiViewer,
    deletingSessionId,
    updatingAiPreferenceSessionId,
    openAiViewer,
    createSession,
    removeSession,
    renameSession,
    updateSessionAiPreference,
  } = useHomeSessions({
    apiBase,
    token,
    onAuthExpired: handleAuthExpired,
    onEnterSession: (sessionId) => {
      navigate(`/viewer/${encodeURIComponent(sessionId)}`);
    },
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
    onAuthExpired: handleAuthExpired,
    onOpenTerminalSession: (terminalSessionId) => {
      navigate(`/terminal/${encodeURIComponent(terminalSessionId)}`);
    },
  });

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-8 sm:py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.75),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(68,136,146,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,166,122,0.18),transparent_28%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col gap-8">
        <HomeHeader
          terminalLoading={terminalLoading}
          connections={connections}
          activeConnectionId={activeConnectionId}
          connectionName={connectionName}
          onSelectConnection={onSelectConnection}
          onOpenConnectionManager={onOpenConnectionManager}
          onOpenTerminal={() => {
            void createTerminal();
          }}
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

        <section className="grid flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <HomeSidebar
            sessionSourceType={sessionSourceType}
            onSessionSourceTypeChange={setSessionSourceType}
            sessionName={sessionName}
            onSessionNameChange={setSessionName}
            cdpEndpoint={cdpEndpoint}
            cdpEndpointPlaceholder={defaultCdpEndpoint}
            onCdpEndpointChange={setCdpEndpoint}
            proxyEnabled={proxyEnabled}
            onProxyEnabledChange={setProxyEnabled}
            requestHeadersInput={requestHeadersInput}
            onRequestHeadersInputChange={setRequestHeadersInput}
            preferredForAi={preferredForAi}
            onPreferredForAiChange={setPreferredForAi}
            loading={loading}
            onSubmitSession={() => {
              void createSession();
            }}
            error={error}
          />

          <section className="flex min-h-[200px] flex-col rounded-[2rem] border border-border/60 bg-card/75 p-6 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
                  Sessions
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {loadingSessions ? "Refreshing quietly..." : `${sortedSessions.length} total`}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full px-4"
                onClick={() => {
                  void openAiViewer();
                }}
                disabled={openingAiViewer}
              >
                {openingAiViewer ? "Opening..." : "Open Default AI Viewer"}
              </Button>
            </div>

            <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              <SessionList
                sessions={sortedSessions}
                loadingSessions={loadingSessions}
                deletingSessionId={deletingSessionId}
                updatingAiPreferenceSessionId={updatingAiPreferenceSessionId}
                onRenameSession={(sessionId) => {
                  void renameSession(sessionId);
                }}
                onRemoveSession={(sessionId) => {
                  void removeSession(sessionId);
                }}
                onResumeSession={(sessionId) => {
                  navigate(`/viewer/${encodeURIComponent(sessionId)}`);
                }}
                onToggleAiPreference={(sessionId, nextPreferredForAi) => {
                  void updateSessionAiPreference(sessionId, nextPreferredForAi);
                }}
              />
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
