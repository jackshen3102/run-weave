import {
  ArrowLeft,
  ArrowRight,
  Code2,
  ExternalLink,
  RotateCw,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { FormEvent } from "react";
import {
  type TerminalBrowserHeaderRule,
  type TerminalBrowserProxyState,
} from "@browser-viewer/shared";
import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";
import { TerminalBrowserCdpEndpointPopover } from "./terminal-browser-cdp-endpoint-popover";
import { TerminalBrowserDeviceButton } from "./terminal-browser-device-panel";
import { TerminalBrowserHeadersButton } from "./terminal-browser-headers-panel";
import { Button } from "../ui/button";

interface TerminalBrowserNavigationBarProps {
  activeTab: TerminalBrowserTabState;
  isElectron: boolean;
  proxyState: TerminalBrowserProxyState | null;
  proxySwitching: boolean;
  headerRulesPanelOpen: boolean;
  headerRules: TerminalBrowserHeaderRule[];
  devicePanelOpen: boolean;
  deviceSwitching: boolean;
  onSubmitAddress: (event: FormEvent<HTMLFormElement>) => void;
  onAddressInputChange: (value: string) => void;
  onGo: (direction: "back" | "forward") => void;
  onReload: () => void;
  onStop: () => void;
  onToggleProxy: () => void;
  onDevicePanelOpenChange: (open: boolean) => void;
  onHeaderRulesPanelOpenChange: (open: boolean) => void;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
}

export function TerminalBrowserNavigationBar({
  activeTab,
  isElectron,
  proxyState,
  proxySwitching,
  headerRulesPanelOpen,
  headerRules,
  devicePanelOpen,
  deviceSwitching,
  onSubmitAddress,
  onAddressInputChange,
  onGo,
  onReload,
  onStop,
  onToggleProxy,
  onDevicePanelOpenChange,
  onHeaderRulesPanelOpenChange,
  onOpenDevTools,
  onOpenExternal,
}: TerminalBrowserNavigationBarProps) {
  const deviceState = activeTab.deviceState;

  return (
    <form
      className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-800 px-2"
      onSubmit={onSubmitAddress}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        disabled={!isElectron || !activeTab.canGoBack}
        onClick={() => onGo("back")}
        aria-label="Go back"
        title="Go back"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        disabled={!isElectron || !activeTab.canGoForward}
        onClick={() => onGo("forward")}
        aria-label="Go forward"
        title="Go forward"
      >
        <ArrowRight className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        onClick={activeTab.loading ? onStop : onReload}
        aria-label={activeTab.loading ? "Stop loading" : "Reload"}
        title={activeTab.loading ? "Stop loading" : "Reload"}
      >
        {activeTab.loading ? (
          <Square className="h-3.5 w-3.5" />
        ) : (
          <RotateCw className="h-4 w-4" />
        )}
      </Button>
      <input
        aria-label="Browser address"
        className="h-7 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-500"
        value={activeTab.addressInput}
        onChange={(event) => onAddressInputChange(event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={[
          "h-7 w-7 rounded-md px-0",
          proxyState?.enabled
            ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200"
            : "",
        ].join(" ")}
        disabled={!isElectron || proxySwitching}
        onClick={onToggleProxy}
        aria-label={
          proxyState?.enabled ? "Disable browser proxy" : "Enable browser proxy"
        }
        title={
          proxyState?.enabled
            ? `Proxy enabled: ${proxyState.proxyRules}`
            : "Enable browser proxy"
        }
      >
        {proxyState?.enabled ? (
          <Wifi className="h-4 w-4" />
        ) : (
          <WifiOff className="h-4 w-4" />
        )}
      </Button>
      {isElectron ? (
        <TerminalBrowserHeadersButton
          open={headerRulesPanelOpen}
          rules={headerRules}
          onOpenChange={onHeaderRulesPanelOpenChange}
        />
      ) : null}
      {isElectron ? (
        <TerminalBrowserDeviceButton
          open={devicePanelOpen}
          deviceState={deviceState}
          switching={deviceSwitching}
          onOpenChange={onDevicePanelOpenChange}
        />
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        disabled={
          !isElectron ||
          activeTab.cdpProxyAttached === true ||
          activeTab.deviceState.mobile
        }
        onClick={onOpenDevTools}
        aria-label={
          activeTab.cdpProxyAttached
            ? "DevTools unavailable while CDP proxy is active"
            : activeTab.deviceState.mobile
              ? "DevTools unavailable while mobile mode is active"
            : "Open browser DevTools"
        }
        title={
          activeTab.cdpProxyAttached
            ? "DevTools unavailable while CDP proxy is active"
            : activeTab.deviceState.mobile
              ? "DevTools unavailable while mobile mode is active"
            : "Open browser DevTools"
        }
      >
        <Code2 className="h-4 w-4" />
      </Button>
      {isElectron ? <TerminalBrowserCdpEndpointPopover tabId={activeTab.id} /> : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        onClick={onOpenExternal}
        aria-label="Open in system browser"
        title="Open in system browser"
      >
        <ExternalLink className="h-4 w-4" />
      </Button>
    </form>
  );
}
