import { useMemoizedFn } from "ahooks";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Ellipsis,
  MessageSquarePlus,
  RotateCw,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { type TerminalBrowserHeaderRule } from "@runweave/shared/terminal-browser-headers";
import { type TerminalBrowserProxyState } from "@runweave/shared/terminal-browser-proxy";
import type { TerminalBrowserToolMenuAction } from "@runweave/shared/terminal-browser-tool-menu";
import {
  DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
  getNextTerminalBrowserDisplayScale,
  getPreviousTerminalBrowserDisplayScale,
} from "@runweave/shared/terminal-browser-display-scale";
import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";
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
  count: number;
  panelOpen: boolean;
  selecting: boolean;
  onOpenPanel: () => void;
  onToggle: () => void;
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
  onSetDisplayScale: (factor: number) => void;
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
    count: annotationCount,
    panelOpen: annotationPanelOpen,
    selecting: annotationSelecting,
    onOpenPanel: onOpenAnnotationPanel,
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
  const {
    isElectron,
    onOpenDevTools,
    onOpenExternal,
    onSetDisplayScale,
  } = utilities;
  const moreToolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const hasAnnotations = annotationCount > 0;
  const hasHeaderRules = headerRules.length > 0;

  const copyAddress = useMemoizedFn(async () => {
    if (!activeTab.addressInput || !navigator.clipboard?.writeText) {
      return;
    }
    await navigator.clipboard.writeText(activeTab.addressInput);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 1500);
  });

  const handleMoreTool = useMemoizedFn(
    (action: TerminalBrowserToolMenuAction | null | undefined) => {
      switch (action) {
        case "toggle-annotation":
          onToggleAnnotation();
          break;
        case "open-headers":
          onHeaderRulesPanelOpenChange(true);
          break;
        case "open-device":
          onDevicePanelOpenChange(true);
          break;
        case "open-devtools":
          onOpenDevTools();
          break;
        case "open-external":
          onOpenExternal();
          break;
        case "zoom-out": {
          const factor = getPreviousTerminalBrowserDisplayScale(
            activeTab.displayScale,
          );
          if (factor !== null) {
            onSetDisplayScale(factor);
          }
          break;
        }
        case "zoom-in": {
          const factor = getNextTerminalBrowserDisplayScale(
            activeTab.displayScale,
          );
          if (factor !== null) {
            onSetDisplayScale(factor);
          }
          break;
        }
        case "reset-zoom":
          onSetDisplayScale(DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE);
          break;
      }
    },
  );

  const openMoreTools = useMemoizedFn(async () => {
    const rect = moreToolsButtonRef.current?.getBoundingClientRect();
    const openToolMenu = window.electronAPI?.terminalBrowserOpenToolMenu;
    if (!rect || !openToolMenu) {
      return;
    }

    setMoreToolsOpen(true);
    try {
      const action = await openToolMenu({
        x: rect.left,
        y: rect.bottom,
        showAnnotation: !hasAnnotations,
        annotationActive: annotationSelecting,
        showHeaders: !hasHeaderRules,
        deviceEnabled: !deviceSwitching,
        devtoolsEnabled:
          activeTab.cdpProxyAttached !== true && !activeTab.deviceState.mobile,
        displayScale: activeTab.displayScale,
      });
      handleMoreTool(action);
    } finally {
      setMoreToolsOpen(false);
    }
  });

  const annotationButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={[
        "relative h-7 w-7 rounded-md px-0",
        annotationPanelOpen || annotationSelecting
          ? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/20 hover:text-sky-200"
          : "",
      ].join(" ")}
      disabled={!isElectron}
      onClick={hasAnnotations ? onOpenAnnotationPanel : onToggleAnnotation}
      aria-label={
        hasAnnotations
          ? "Open browser comments"
          : annotationSelecting
            ? "Pause browser comments"
            : "Add browser comments"
      }
      title={
        hasAnnotations
          ? "Open browser comments"
          : annotationSelecting
            ? "Pause browser comments"
            : "Add browser comments"
      }
    >
      <MessageSquarePlus className="h-4 w-4" />
      {annotationCount > 0 ? (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold leading-none text-white">
          {annotationCount}
        </span>
      ) : null}
    </Button>
  );

  return (
    <div className="shrink-0">
      <form
        className="flex h-10 items-center gap-1 border-b border-slate-800 px-2"
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
            "h-7 w-7 rounded-md px-0",
            proxyState?.enabled
              ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200"
              : "",
          ].join(" ")}
          disabled={!isElectron || proxySwitching}
          onClick={onToggleProxy}
          aria-label={
            proxyState?.enabled
              ? "Disable browser proxy"
              : "Enable browser proxy"
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
        {hasAnnotations ? annotationButton : null}
        {isElectron && hasHeaderRules ? (
          <TerminalBrowserHeadersButton
            open={headerRulesPanelOpen}
            rules={headerRules}
            onOpenChange={onHeaderRulesPanelOpenChange}
          />
        ) : null}
        <Button
          ref={moreToolsButtonRef}
          type="button"
          size="sm"
          variant="ghost"
          className={[
            "h-7 w-7 rounded-md px-0",
            moreToolsOpen ||
            devicePanelOpen ||
            (headerRulesPanelOpen && !hasHeaderRules)
              ? "bg-slate-800 text-slate-100"
              : "",
          ].join(" ")}
          aria-expanded={moreToolsOpen}
          aria-haspopup="menu"
          disabled={!isElectron || moreToolsOpen}
          onClick={() => void openMoreTools()}
          aria-label="More browser tools"
          title="More browser tools"
        >
          <Ellipsis className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
