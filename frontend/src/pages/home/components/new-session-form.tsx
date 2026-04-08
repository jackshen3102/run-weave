import { Button } from "../../../components/ui/button";

interface NewSessionFormProps {
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
  onSubmit: () => void;
  error: string | null;
}

export function NewSessionForm({
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
  onSubmit,
  error,
}: NewSessionFormProps) {
  return (
    <section className="w-full rounded-[1.5rem] border border-border/60 bg-background/48 p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
          New Session
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-1.5 rounded-full border border-border/60 bg-background/60 p-0.5">
          <Button
            type="button"
            variant={sessionSourceType === "connect-cdp" ? "default" : "ghost"}
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => onSessionSourceTypeChange("connect-cdp")}
            disabled={loading}
          >
            Attach Browser
          </Button>
          <Button
            type="button"
            variant={sessionSourceType === "launch" ? "default" : "ghost"}
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => onSessionSourceTypeChange("launch")}
            disabled={loading}
          >
            New Browser
          </Button>
        </div>

        <div className="rounded-[1rem] border border-primary/40 bg-card/85 px-3 py-2.5">
          <p className="mb-2 text-xs text-muted-foreground">
            Session name
          </p>
          <input
            id="session-name"
            aria-label="Session name"
            value={sessionName}
            onChange={(event) => onSessionNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !loading) {
                event.preventDefault();
                onSubmit();
              }
            }}
            disabled={loading}
            className="h-10 w-full rounded-[0.9rem] border border-border/60 bg-background/70 px-3 text-sm outline-none placeholder:text-muted-foreground/55"
            placeholder="Default Playweight"
          />
        </div>

        {sessionSourceType === "connect-cdp" ? (
          <div className="rounded-[1rem] border border-primary/40 bg-card/85 px-3 py-2.5">
            <p className="mb-2 text-xs text-muted-foreground">
              Connect to an existing Chromium CDP endpoint.
            </p>
            <input
              id="session-cdp-endpoint"
              aria-label="CDP endpoint"
              value={cdpEndpoint}
              onChange={(event) => onCdpEndpointChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !loading) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              disabled={loading}
              className="h-10 w-full rounded-[0.9rem] border border-border/60 bg-background/70 px-3 text-sm outline-none placeholder:text-muted-foreground/55"
              placeholder={cdpEndpointPlaceholder}
            />
          </div>
        ) : null}

        {sessionSourceType === "launch" ? (
          <label
            htmlFor="session-preferred-for-ai"
            className="flex items-center justify-between gap-4 rounded-[1rem] border border-border/60 bg-card/75 px-3 py-3 text-sm text-foreground"
          >
            <span className="space-y-1">
              <span className="block font-medium">Default AI Viewer</span>
              <span className="block text-xs text-muted-foreground">
                Mark this persistent browser as the default AI viewer session.
              </span>
            </span>
            <input
              id="session-preferred-for-ai"
              type="checkbox"
              aria-label="Default AI Viewer"
              checked={preferredForAi}
              onChange={(event) => onPreferredForAiChange(event.target.checked)}
              disabled={loading}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary/40"
            />
          </label>
        ) : null}

        {sessionSourceType === "launch" ? (
          <div className="space-y-3">
            <label
              htmlFor="session-proxy-enabled"
              className="flex items-center justify-between gap-4 rounded-[1rem] border border-border/60 bg-card/75 px-3 py-3 text-sm text-foreground"
            >
              <span className="space-y-1">
                <span className="block font-medium">Enable proxy</span>
                <span className="block text-xs text-muted-foreground">
                  Route this session through Whistle at 127.0.0.1:8899.
                </span>
              </span>
              <input
                id="session-proxy-enabled"
                type="checkbox"
                aria-label="Enable proxy"
                checked={proxyEnabled}
                onChange={(event) => onProxyEnabledChange(event.target.checked)}
                disabled={loading}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary/40"
              />
            </label>

            <div className="rounded-[1rem] border border-border/60 bg-card/75 px-3 py-3">
              <label
                className="block text-sm font-medium text-foreground"
                htmlFor="session-request-headers"
              >
                Request headers
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional JSON object applied to every request in this session.
              </p>
              <textarea
                id="session-request-headers"
                aria-label="Request headers"
                value={requestHeadersInput}
                onChange={(event) => onRequestHeadersInputChange(event.target.value)}
                disabled={loading}
                className="mt-3 min-h-28 w-full rounded-[0.9rem] border border-border/60 bg-background/70 px-3 py-3 text-sm outline-none placeholder:text-muted-foreground/55"
                placeholder='{"x-session-id":"demo","x-team":"alpha"}'
              />
            </div>
          </div>
        ) : null}

        <Button
          className="h-10 w-full rounded-full text-[13px] font-medium"
          onClick={onSubmit}
          disabled={loading}
        >
          {loading ? "Starting..." : "Connect"}
        </Button>

        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
