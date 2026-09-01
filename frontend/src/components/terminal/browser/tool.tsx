import { useMemoizedFn } from "ahooks";
import { useEffect, useState } from "react";
import { useTerminalBrowserController } from "./use-controller";
import { TerminalBrowserErrorBanners } from "./error-banners";
import { TerminalBrowserNavigationBar } from "./navigation-bar";
import { TerminalBrowserAnnotationModeBar } from "./annotations-panel";
import { TerminalBrowserSurface } from "./surface";
import { TerminalBrowserTabs } from "./tabs";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

interface TerminalBrowserToolProps {
  active: boolean;
  profileId: TerminalBrowserProfileId;
  activationProjectId: string | null;
  activationRevision: number;
  currentProjectId: string | null;
  apiBase: string;
  token: string;
  terminalSessionId: string | null;
}

export function TerminalBrowserTool({
  active,
  profileId,
  activationProjectId,
  activationRevision,
  currentProjectId,
  apiBase,
  token,
  terminalSessionId,
}: TerminalBrowserToolProps) {
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const controller = useTerminalBrowserController({
    active,
    nativeViewSuppressed: profileSettingsOpen,
    profileId,
    activationProjectId,
    activationRevision,
    apiBase,
    token,
    terminalSessionId,
  });

  const activeTabId = controller?.activeTab.id ?? null;
  const controllerIsElectron = controller?.isElectron === true;
  const handleProfileSettingsOpenChange = useMemoizedFn(
    async (open: boolean): Promise<void> => {
      if (open && controllerIsElectron && activeTabId) {
        await window.electronAPI?.terminalBrowserHide?.(activeTabId);
      }
      setProfileSettingsOpen(open);
    },
  );

  useEffect(() => {
    if (!active) {
      setProfileSettingsOpen(false);
    }
  }, [active]);

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
    horizontalViewport,
    groups,
    handleAddressBlur,
    handleAddressFocus,
    isElectron,
    mobileDisabledReason,
    openUrlExternally,
    openAnnotationPanel,
    profileError,
    profileResolving,
    reload,
    renameGroup,
    reorderTabs,
    saveHeaderRules,
    selectDevicePreset,
    setDisplayScale,
    setHorizontalOffset,
    setMinimumViewportWidth,
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
        profile={{
          profileId,
          projectId: currentProjectId,
          resolving: profileResolving,
          resolutionError: profileError,
          settingsOpen: profileSettingsOpen,
          onSettingsOpenChange: (open) => {
            void handleProfileSettingsOpenChange(open);
          },
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
          onSetMinimumViewportWidth: (width) =>
            void setMinimumViewportWidth(width),
        }}
      />
      <TerminalBrowserAnnotationModeBar
        selecting={annotationState.selecting}
        onDone={() => void setAnnotationSelecting(false)}
      />
      <TerminalBrowserErrorBanners
        errors={[
          profileError,
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
        horizontalViewport={{
          ...horizontalViewport,
          onScroll: setHorizontalOffset,
        }}
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
