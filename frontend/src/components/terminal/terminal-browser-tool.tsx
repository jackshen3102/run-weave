import { useTerminalBrowserController } from "./use-terminal-browser-controller";
import { TerminalBrowserErrorBanners } from "./terminal-browser-error-banners";
import { TerminalBrowserNavigationBar } from "./terminal-browser-navigation-bar";
import { TerminalBrowserSurface } from "./terminal-browser-surface";
import { TerminalBrowserTabs } from "./terminal-browser-tabs";

interface TerminalBrowserToolProps {
  active: boolean;
}

export function TerminalBrowserTool({ active }: TerminalBrowserToolProps) {
  const controller = useTerminalBrowserController({ active });

  if (!controller) {
    return null;
  }

  const {
    activeTab,
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
    isElectron,
    mobileDisabledReason,
    openUrlExternally,
    proxyError,
    proxyState,
    proxySwitching,
    reload,
    reorderBrowserTabs,
    saveHeaderRules,
    selectDevicePreset,
    setActiveBrowserTab,
    setDevicePanelOpenState,
    setHeaderPanelOpen,
    stop,
    submitAddress,
    surfaceContainerRef,
    tabs,
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
        onReorder={reorderBrowserTabs}
      />
      <TerminalBrowserNavigationBar
        activeTab={activeTab}
        isElectron={isElectron}
        proxyState={proxyState}
        proxySwitching={proxySwitching}
        headerRulesPanelOpen={headerRulesPanelOpen}
        headerRules={headerRules}
        devicePanelOpen={devicePanelOpen}
        deviceSwitching={deviceSwitching}
        onSubmitAddress={submitAddress}
        onAddressInputChange={(addressInput) =>
          updateBrowserTab(activeTab.id, { addressInput })
        }
        onGo={(direction) => void go(direction)}
        onReload={() => void reload()}
        onStop={stop}
        onToggleProxy={() => void toggleProxy()}
        onDevicePanelOpenChange={setDevicePanelOpenState}
        onHeaderRulesPanelOpenChange={setHeaderPanelOpen}
        onOpenDevTools={() => {
          void window.electronAPI?.terminalBrowserOpenDevTools?.(activeTab.id);
        }}
        onOpenExternal={() => openUrlExternally(activeTab.url)}
      />
      <TerminalBrowserErrorBanners
        errors={[proxyError, headerError, activeTab.error]}
      />
      <TerminalBrowserSurface
        containerRef={surfaceContainerRef}
        browserViewRef={browserViewRef}
        isElectron={isElectron}
        headerRulesPanelOpen={headerRulesPanelOpen}
        headerRules={headerRules}
        devicePanelOpen={devicePanelOpen}
        deviceState={activeTab.deviceState}
        deviceSwitching={deviceSwitching}
        mobileDisabledReason={mobileDisabledReason}
        headerSaving={headerSaving}
        headerError={headerError}
        onCloseHeaderRulesPanel={() => setHeaderPanelOpen(false)}
        onCloseDevicePanel={() => setDevicePanelOpenState(false)}
        onSelectDevicePreset={(presetId) => void selectDevicePreset(presetId)}
        onSaveHeaderRules={saveHeaderRules}
        onReload={() => void reload()}
        onOpenExternal={() => openUrlExternally(activeTab.url)}
      />
    </div>
  );
}
