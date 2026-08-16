import { useTerminalBrowserController } from "./use-controller";
import { TerminalBrowserErrorBanners } from "./error-banners";
import { TerminalBrowserNavigationBar } from "./navigation-bar";
import { TerminalBrowserAnnotationModeBar } from "./annotations-panel";
import { TerminalBrowserSurface } from "./surface";
import { TerminalBrowserTabs } from "./tabs";

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
    annotationPanelOpen,
    annotationError,
    annotationState,
    annotationSubmitting,
    browserViewRef,
    closeTab,
    closeGroup,
    closeAnnotationPanel,
    createBrowserTab,
    createBrowserGroup,
    deleteAnnotation,
    devicePanelOpen,
    deviceSwitching,
    go,
    headerError,
    headerRules,
    headerRulesPanelOpen,
    headerSaving,
    groups,
    handleAddressBlur,
    handleAddressFocus,
    isElectron,
    mobileDisabledReason,
    openUrlExternally,
    openAnnotationPanel,
    proxyError,
    proxyState,
    proxySwitching,
    reload,
    renameGroup,
    reorderTabs,
    saveHeaderRules,
    selectDevicePreset,
    setDisplayScale,
    setActiveBrowserTab,
    setAnnotationSelecting,
    setDevicePanelOpenState,
    setHeaderPanelOpen,
    stop,
    discardAnnotations,
    submitAddress,
    submitAnnotations,
    surfaceContainerRef,
    tabs,
    toggleAnnotation,
    toggleProxy,
    setProxyPort,
    updateBrowserTab,
    focusAnnotation,
  } = controller;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <TerminalBrowserTabs
        tabs={tabs}
        groups={groups}
        activeTabId={activeTab.id}
        onCreateTab={() => createBrowserTab()}
        onCreateGroup={createBrowserGroup}
        onSelectTab={setActiveBrowserTab}
        onCloseTab={closeTab}
        onReorder={reorderTabs}
        onRenameGroup={renameGroup}
        onCloseGroup={closeGroup}
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
          count: annotationState.annotations.length,
          panelOpen: annotationPanelOpen,
          selecting: annotationState.selecting,
          onOpenPanel: openAnnotationPanel,
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
          onSetPort: (port) => setProxyPort(port),
        }}
        utilities={{
          isElectron,
          onOpenDevTools: () => {
            void window.electronAPI?.terminalBrowserOpenDevTools?.(
              activeTab.id,
            );
          },
          onOpenExternal: () => openUrlExternally(activeTab.url),
          onSetDisplayScale: (factor) => void setDisplayScale(factor),
        }}
      />
      <TerminalBrowserAnnotationModeBar
        selecting={annotationState.selecting}
        onDone={() => void setAnnotationSelecting(false)}
      />
      <TerminalBrowserErrorBanners
        errors={[
          proxyError,
          headerError,
          annotationPanelOpen ? null : annotationError,
          activeTab.navigationError,
          activeTab.error,
        ]}
      />
      <TerminalBrowserSurface
        annotations={{
          error: annotationError,
          open: annotationPanelOpen,
          state: annotationState,
          submitting: annotationSubmitting,
          onClose: () => void closeAnnotationPanel(),
          onDelete: (annotationId) => void deleteAnnotation(annotationId),
          onDiscard: () => void discardAnnotations(),
          onFocus: (annotationId) => void focusAnnotation(annotationId),
          onSelectingChange: (selecting) =>
            void setAnnotationSelecting(selecting),
          onSubmit: () => void submitAnnotations(),
        }}
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
