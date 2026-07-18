import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import type { TerminalBrowserDevicePresetId } from "@runweave/shared/terminal-browser-device";
import { aiDiagnosticLog } from "../../features/diagnostic-logs/recorder";
import type {
  TerminalBrowserTabState,
  TerminalPreviewStore,
} from "../../features/terminal/preview-store-types";

interface UseTerminalBrowserDeviceSelectionOptions {
  activeTab: TerminalBrowserTabState | undefined;
  isElectron: boolean;
  updateBrowserTab: TerminalPreviewStore["updateBrowserTab"];
}

export function useTerminalBrowserDeviceSelection({
  activeTab,
  isElectron,
  updateBrowserTab,
}: UseTerminalBrowserDeviceSelectionOptions) {
  const [deviceSwitching, setDeviceSwitching] = useState(false);

  const selectDevicePreset = useMemoizedFn(
    async (presetId: TerminalBrowserDevicePresetId): Promise<void> => {
      if (!activeTab || !isElectron || deviceSwitching) {
        return;
      }
      setDeviceSwitching(true);
      updateBrowserTab(activeTab.id, { error: undefined });
      aiDiagnosticLog("terminal browser device preset selected", {
        tabId: activeTab.id,
        previousPresetId: activeTab.deviceState.presetId,
        nextPresetId: presetId,
        previousLogicalWidth: activeTab.deviceState.viewport?.width ?? null,
        previousLogicalHeight: activeTab.deviceState.viewport?.height ?? null,
      });
      try {
        const deviceState =
          await window.electronAPI?.terminalBrowserSetDeviceState?.(
            activeTab.id,
            presetId,
          );
        aiDiagnosticLog("terminal browser device preset applied", {
          tabId: activeTab.id,
          nextPresetId: presetId,
          returnedPresetId: deviceState?.presetId ?? null,
          returnedLogicalWidth: deviceState?.viewport?.width ?? null,
          returnedLogicalHeight: deviceState?.viewport?.height ?? null,
        });
        if (deviceState) {
          updateBrowserTab(activeTab.id, { deviceState, error: undefined });
        }
      } catch (error) {
        updateBrowserTab(activeTab.id, {
          error:
            error instanceof Error
              ? error.message
              : "Failed to switch device mode",
        });
      } finally {
        setDeviceSwitching(false);
      }
    },
  );

  return { deviceSwitching, selectDevicePreset };
}
