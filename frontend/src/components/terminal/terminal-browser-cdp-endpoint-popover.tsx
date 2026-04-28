import { Cable, Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import type { TerminalBrowserCdpProxyInfo } from "@browser-viewer/shared";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface TerminalBrowserCdpEndpointPopoverProps {
  tabId: string;
}

export function TerminalBrowserCdpEndpointPopover({
  tabId,
}: TerminalBrowserCdpEndpointPopoverProps) {
  const [info, setInfo] = useState<TerminalBrowserCdpProxyInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const updateBrowserTab = useTerminalPreviewStore(
    (state) => state.updateBrowserTab,
  );

  const fetchInfo = useCallback(async () => {
    const result =
      await window.electronAPI?.terminalBrowserGetCdpProxyInfo?.(tabId);
    if (!result) {
      return;
    }
    setInfo(result);
    updateBrowserTab(tabId, {
      cdpProxyAttached: result.attached,
      devtoolsOpen: result.devtoolsOpen,
    });
  }, [tabId, updateBrowserTab]);

  const copyEndpoint = useCallback(async () => {
    if (!info?.endpoint) {
      return;
    }
    await navigator.clipboard.writeText(info.endpoint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [info?.endpoint]);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          void fetchInfo();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          aria-label="CDP/AI endpoint"
          title="CDP/AI endpoint"
        >
          <Cable className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
        <p className="text-xs font-medium text-slate-200">
          CDP Proxy Endpoint
        </p>
        {info?.error ? (
          <p className="text-xs text-rose-400">{info.error}</p>
        ) : null}
        {info?.devtoolsOpen ? (
          <p className="text-xs text-amber-400">
            DevTools is open, CDP proxy unavailable for this tab
          </p>
        ) : null}
        {info?.endpoint && !info.devtoolsOpen ? (
          <>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-sky-300">
                {info.endpoint}
              </code>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 rounded-md px-0"
                aria-label="Copy endpoint"
                title="Copy endpoint"
                onClick={() => void copyEndpoint()}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            {info.attached ? (
              <p className="text-xs text-emerald-400">CDP proxy connected</p>
            ) : null}
            <p className="text-[10px] leading-tight text-slate-500">
              This is a Runweave CDP Proxy endpoint, not the Electron native CDP.
              Use with Playwright CLI / MCP via{" "}
              <code className="text-slate-400">
                chromium.connectOverCDP(&quot;{info.endpoint}&quot;)
              </code>
            </p>
          </>
        ) : null}
        {!info ? <p className="text-xs text-slate-500">Loading...</p> : null}
      </PopoverContent>
    </Popover>
  );
}
