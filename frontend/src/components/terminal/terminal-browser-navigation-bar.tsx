import { useMemoizedFn } from "ahooks";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  Copy,
  ExternalLink,
  MessageSquarePlus,
  RotateCw,
  Send,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { type TerminalBrowserHeaderRule } from "@runweave/shared/terminal-browser-headers";
import { type TerminalBrowserProxyState } from "@runweave/shared/terminal-browser-proxy";
import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";
import { TerminalBrowserDeviceButton } from "./terminal-browser-device-panel";
import { TerminalBrowserHeadersButton } from "./terminal-browser-headers-panel";
import { Button } from "../ui/button";

interface BrowserAddressControls {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}

interface BrowserNavigationControls {
  onGo: (direction: "back" | "forward") => void;
  onReload: () => void;
  onStop: () => void;
}

interface BrowserAnnotationControls {
  active: boolean;
  count: number;
  submitting: boolean;
  onToggle: () => void;
  onSubmit: () => void;
}

interface BrowserProxyControls {
  state: TerminalBrowserProxyState | null;
  switching: boolean;
  onToggle: () => void;
}

interface BrowserPanelControls {
  headerRulesOpen: boolean;
  headerRules: TerminalBrowserHeaderRule[];
  deviceOpen: boolean;
  deviceSwitching: boolean;
  onDeviceOpenChange: (open: boolean) => void;
  onHeaderRulesOpenChange: (open: boolean) => void;
}

interface BrowserUtilityControls {
  isElectron: boolean;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
}

interface TerminalBrowserNavigationBarProps {
  activeTab: TerminalBrowserTabState;
  address: BrowserAddressControls;
  annotation: BrowserAnnotationControls;
  navigation: BrowserNavigationControls;
  panels: BrowserPanelControls;
  proxy: BrowserProxyControls;
  utilities: BrowserUtilityControls;
}

export function TerminalBrowserNavigationBar({
  activeTab,
  address,
  annotation,
  navigation,
  panels,
  proxy,
  utilities,
}: TerminalBrowserNavigationBarProps) {
  const {
    onBlur: onAddressBlur,
    onChange: onAddressInputChange,
    onFocus: onAddressFocus,
    onSubmit: onSubmitAddress,
  } = address;
  const {
    active: annotationActive,
    count: annotationCount,
    submitting: annotationSubmitting,
    onSubmit: onSubmitAnnotations,
    onToggle: onToggleAnnotation,
  } = annotation;
  const { onGo, onReload, onStop } = navigation;
  const {
    deviceOpen: devicePanelOpen,
    deviceSwitching,
    headerRules,
    headerRulesOpen: headerRulesPanelOpen,
    onDeviceOpenChange: onDevicePanelOpenChange,
    onHeaderRulesOpenChange: onHeaderRulesPanelOpenChange,
  } = panels;
  const {
    state: proxyState,
    switching: proxySwitching,
    onToggle: onToggleProxy,
  } = proxy;
  const { isElectron, onOpenDevTools, onOpenExternal } = utilities;
  const deviceState = activeTab.deviceState;
  const [addressCopied, setAddressCopied] = useState(false);

  const copyAddress = useMemoizedFn(async () => {
    if (!activeTab.addressInput || !navigator.clipboard?.writeText) {
      return;
    }
    await navigator.clipboard.writeText(activeTab.addressInput);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 1500);
  });

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
        onFocus={onAddressFocus}
        onBlur={onAddressBlur}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        disabled={!activeTab.addressInput}
        onClick={() => void copyAddress()}
        aria-label={addressCopied ? "Address copied" : "Copy address"}
        title={addressCopied ? "Address copied" : "Copy address"}
      >
        {addressCopied ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={[
          "relative h-7 w-7 rounded-md px-0",
          annotationActive
            ? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/20 hover:text-sky-200"
            : "",
        ].join(" ")}
        disabled={!isElectron}
        onClick={onToggleAnnotation}
        aria-label={
          annotationActive ? "Stop browser comments" : "Add browser comments"
        }
        title={
          annotationActive ? "Stop browser comments" : "Add browser comments"
        }
      >
        <MessageSquarePlus className="h-4 w-4" />
        {annotationCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold leading-none text-white">
            {annotationCount}
          </span>
        ) : null}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 rounded-md px-0"
        disabled={
          !isElectron ||
          !annotationActive ||
          annotationCount === 0 ||
          annotationSubmitting
        }
        onClick={onSubmitAnnotations}
        aria-label="Submit browser comments"
        title={
          annotationCount > 0
            ? "Submit browser comments"
            : "Select an element in the browser to add a comment"
        }
      >
        <Send className="h-4 w-4" />
      </Button>
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
