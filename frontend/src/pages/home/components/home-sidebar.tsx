import { NewSessionForm } from "./new-session-form";

interface HomeSidebarProps {
  sessionSourceType: "launch" | "connect-cdp";
  onSessionSourceTypeChange: (value: "launch" | "connect-cdp") => void;
  sessionName: string;
  onSessionNameChange: (value: string) => void;
  cdpEndpoint: string;
  cdpEndpointPlaceholder: string;
  onCdpEndpointChange: (value: string) => void;
  proxyEnabled: boolean;
  onProxyEnabledChange: (value: boolean) => void;
  requestHeadersInput: string;
  onRequestHeadersInputChange: (value: string) => void;
  preferredForAi: boolean;
  onPreferredForAiChange: (value: boolean) => void;
  loading: boolean;
  onSubmitSession: () => void;
  error: string | null;
}

export function HomeSidebar({
  sessionSourceType,
  onSessionSourceTypeChange,
  sessionName,
  onSessionNameChange,
  cdpEndpoint,
  cdpEndpointPlaceholder,
  onCdpEndpointChange,
  proxyEnabled,
  onProxyEnabledChange,
  requestHeadersInput,
  onRequestHeadersInputChange,
  preferredForAi,
  onPreferredForAiChange,
  loading,
  onSubmitSession,
  error,
}: HomeSidebarProps) {
  return (
    <aside className="flex min-h-0 flex-col gap-5 rounded-[2rem] border border-border/60 bg-card/76 p-4 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl sm:p-5">
      <NewSessionForm
        sessionSourceType={sessionSourceType}
        onSessionSourceTypeChange={onSessionSourceTypeChange}
        sessionName={sessionName}
        onSessionNameChange={onSessionNameChange}
        cdpEndpoint={cdpEndpoint}
        cdpEndpointPlaceholder={cdpEndpointPlaceholder}
        onCdpEndpointChange={onCdpEndpointChange}
        proxyEnabled={proxyEnabled}
        onProxyEnabledChange={onProxyEnabledChange}
        requestHeadersInput={requestHeadersInput}
        onRequestHeadersInputChange={onRequestHeadersInputChange}
        preferredForAi={preferredForAi}
        onPreferredForAiChange={onPreferredForAiChange}
        loading={loading}
        onSubmit={onSubmitSession}
        error={error}
      />
    </aside>
  );
}
