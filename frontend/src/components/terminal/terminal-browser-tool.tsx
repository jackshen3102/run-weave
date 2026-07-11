import { useTerminalBrowserController } from "./use-terminal-browser-controller";
import { TerminalBrowserErrorBanners } from "./terminal-browser-error-banners";
import { TerminalBrowserNavigationBar } from "./terminal-browser-navigation-bar";
import { TerminalBrowserSurface } from "./terminal-browser-surface";
import { TerminalBrowserTabs } from "./terminal-browser-tabs";

interface TerminalBrowserToolProps {
  active: boolean;
  apiBase: string;
  token: string;
  terminalSessionId: string | null;
}

export function TerminalBrowserTool({
  active,
  apiBase,
  token,
  terminalSessionId,
}: TerminalBrowserToolProps) {
  const controller = useTerminalBrowserController({
    active,
    apiBase,
    token,
    terminalSessionId,
  });

  if (!controller) {
    return null;
  }

  const {
    activeTab,
    annotationError,
    annotationState,
    annotationSubmitting,
    browserViewRef,
    closeTab,
    createBrowserTab,
    devicePanelOpen,
    deviceSwitching,
    go,
    headerError,
    headerRules,
    headerRulesPanelOpen,
    headerSaving,
    handleAddressBlur,
    handleAddressFocus,
    isElectron,
    mobileDisabledReason,
    openUrlExternally,
    proxyError,
    proxyState,
    proxySwitching,
    reload,
    reorderTabs,
    saveHeaderRules,
    selectDevicePreset,
    setActiveBrowserTab,
    setDevicePanelOpenState,
    setHeaderPanelOpen,
    stop,
    submitAddress,
    submitAnnotations,
    surfaceContainerRef,
    tabs,
    toggleAnnotation,
    toggleProxy,
    updateBrowserTab,
  } = controller;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <TerminalBrowserTabs
        tabs={tabs}
        activeTabId={activeTab.id}
        onCreateTab={() => createBrowserTab()}
        onSelectTab={setActiveBrowserTab}
        onCloseTab={closeTab}
        onReorder={reorderTabs}
      />
      <TerminalBrowserNavigationBar
        activeTab={activeTab}
        address={{
          onBlur: handleAddressBlur,
          onChange: (addressInput) =>
            updateBrowserTab(activeTab.id, { addressInput }),
          onFocus: handleAddressFocus,
          onSubmit: submitAddress,
        }}
        annotation={{
          active: annotationState.active,
          count: annotationState.annotations.length,
          submitting: annotationSubmitting,
          onSubmit: () => void submitAnnotations(),
          onToggle: () => void toggleAnnotation(),
        }}
        navigation={{
          onGo: (direction) => void go(direction),
          onReload: () => void reload(),
          onStop: stop,
        }}
        panels={{
          deviceOpen: devicePanelOpen,
          deviceSwitching,
          headerRules,
          headerRulesOpen: headerRulesPanelOpen,
          onDeviceOpenChange: setDevicePanelOpenState,
          onHeaderRulesOpenChange: setHeaderPanelOpen,
        }}
        proxy={{
          state: proxyState,
          switching: proxySwitching,
          onToggle: () => void toggleProxy(),
        }}
        utilities={{
          isElectron,
          onOpenDevTools: () => {
            void window.electronAPI?.terminalBrowserOpenDevTools?.(
              activeTab.id,
            );
          },
          onOpenExternal: () => openUrlExternally(activeTab.url),
        }}
      />
      <TerminalBrowserErrorBanners
        errors={[proxyError, headerError, annotationError, activeTab.error]}
      />
      <TerminalBrowserSurface
        refs={{ browserViewRef, containerRef: surfaceContainerRef }}
        environment={{
          isElectron,
          onOpenExternal: () => openUrlExternally(activeTab.url),
        }}
        headers={{
          error: headerError,
          open: headerRulesPanelOpen,
          rules: headerRules,
          saving: headerSaving,
          onClose: () => setHeaderPanelOpen(false),
          onSave: saveHeaderRules,
        }}
        device={{
          disabledReason: mobileDisabledReason,
          open: devicePanelOpen,
          state: activeTab.deviceState,
          switching: deviceSwitching,
          onClose: () => setDevicePanelOpenState(false),
          onSelectPreset: (presetId) => void selectDevicePreset(presetId),
        }}
      />
    </div>
  );
}
