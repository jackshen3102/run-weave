import { BookmarkFeedback } from "../bookmarks/star";
import { BookmarkBar } from "../bookmarks/bar";
import { BookmarkEditors } from "../bookmarks/editor";
import { useBrowserPresentation } from "../../../../features/terminal/browser-presentation/coordinator";
import { openTerminalBrowserUrl } from "../../../../features/terminal/navigation/open-browser";
import { useEffect, useState } from "react";
import { useTerminalBrowserController } from "./use-controller";
import { TerminalBrowserErrorBanners } from "../header/errors";
import { TerminalBrowserNavigationBar } from "../header/navigation";
import { TerminalBrowserAnnotationModeBar } from "../annotations/panel";
import { TerminalBrowserSurface } from "./surface";
import { TerminalBrowserTabs } from "../tabs/index";
import { TerminalBrowserFindBar, useTerminalBrowserFind } from "../find";
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
  const presentation = useBrowserPresentation();
  const controller = useTerminalBrowserController({
    active,
    profileId,
    activationProjectId,
    activationRevision,
    apiBase,
    token,
    terminalSessionId,
  });
  const find = useTerminalBrowserFind(controller?.activeTab.id, active && !presentation.suppressed);

  useEffect(() => {
    if (!active) {
      setProfileSettingsOpen(false);
    }
  }, [active]);

  if (!controller) {
    return null;
  }

  const {
    bookmarks,
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
    <div className="flex h-full min-h-0 flex-col bg-slate-950" onKeyDownCapture={find.onKeyDownCapture}>
      <TerminalBrowserTabs
        tabs={tabs}
        groups={groups}
        activeTabId={activeTab.id}
        onSleepIdleTabs={
          window.electronAPI?.terminalBrowserSleepIdleTabs
            ? () => window.electronAPI!.terminalBrowserSleepIdleTabs!(profileId)
            : undefined
        }
        onCreateTab={() => createBrowserTab()}
        onCreateGroup={createBrowserGroup}
        onSelectTab={setActiveBrowserTab}
        onCloseTab={closeTab}
        onReorder={reorderTabs}
        onRenameGroup={renameGroup}
        onCloseGroup={closeGroup}
      />
      {activeTab.localPreview ? (
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-1 text-xs text-slate-300">
          <span className="truncate" title="临时网站数据；相对资源通过所连接电脑加载。关闭后不保留登录态。">
            {activeTab.localPreview.connectionName} · 电脑本地预览 · 临时会话
          </span>
          <button className="ml-auto shrink-0 text-sky-300 hover:underline" onClick={() => {
            void openTerminalBrowserUrl({ url: activeTab.url, profileId, placement: { kind: "new-group" } })
              .catch((error: Error) => updateBrowserTab(activeTab.id, { error: error.message }));
          }}>在本机打开</button>
        </div>
      ) : null}
      <TerminalBrowserNavigationBar
        onFind={find.supported ? () => void find.command({ action: "open" }) : undefined}
        bookmarks={bookmarks}
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
          onSettingsOpenChange: setProfileSettingsOpen,
        }}
        utilities={{
          isElectron,
          onOpenDevTools: () => {
            void window.electronAPI?.terminalBrowserOpenDevTools?.(
              activeTab.id,
            );
          },
          onOpenExternal: () => activeTab.localPreview
            ? updateBrowserTab(activeTab.id, { error: "此页面需要 Runweave 连接原电脑；如需访问桌面本机，请选择「在本机打开」。" })
            : openUrlExternally(activeTab.url),
          onSetDisplayScale: (factor) => void setDisplayScale(factor),
          onSetMinimumViewportWidth: (width) =>
            void setMinimumViewportWidth(width),
        }}
      />
      <TerminalBrowserFindBar key={activeTab.id} find={find} />
      <BookmarkBar bookmarks={bookmarks} />
      {bookmarks.supported ? <BookmarkEditors bookmarks={bookmarks} /> : null}
      <BookmarkFeedback bookmarks={bookmarks} />
      <TerminalBrowserAnnotationModeBar
        selecting={annotationState.selecting}
        onDone={() => void setAnnotationSelecting(false)}
      />
      {presentation.error ? (
        <div role="alert" className="p-2 text-sm text-amber-400">
          {presentation.error}{" "}
          <button onClick={presentation.retry}>重试显示切换</button>
        </div>
      ) : null}
      <TerminalBrowserErrorBanners
        errors={[
          profileError,
          headerError,
          annotationPanelOpen ? null : annotationError,
          activeTab.navigationError,
          activeTab.error,
          find.error,
        ]}
      />
      <TerminalBrowserSurface
        bookmarks={bookmarks}
        suppressed={presentation.suppressed}
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
