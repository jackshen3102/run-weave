import { Globe2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  type TerminalBrowserDevicePresetId,
  type TerminalBrowserDeviceState,
  type TerminalBrowserHeaderRule,
} from "@runweave/shared";
import { aiDiagnosticLog } from "../../features/diagnostic-logs/recorder";
import { TerminalBrowserDevicePanel } from "./terminal-browser-device-panel";
import { TerminalBrowserHeadersPanel } from "./terminal-browser-headers-panel";
import { Button } from "../ui/button";

const BROWSER_VIEW_GUTTER_PX = 6;
const TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX = 320;
const MOBILE_STAGE_PADDING_PX = 12;
const MIN_MOBILE_SCALE = 0.1;

interface MobileDisplaySize {
  width: number;
  height: number;
}

interface TerminalBrowserSurfaceProps {
  containerRef: RefObject<HTMLDivElement | null>;
  browserViewRef: RefObject<HTMLDivElement | null>;
  isElectron: boolean;
  headerRulesPanelOpen: boolean;
  headerRules: TerminalBrowserHeaderRule[];
  devicePanelOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
  deviceSwitching: boolean;
  mobileDisabledReason: string | null;
  headerSaving: boolean;
  headerError: string | null;
  onCloseHeaderRulesPanel: () => void;
  onCloseDevicePanel: () => void;
  onSelectDevicePreset: (presetId: TerminalBrowserDevicePresetId) => void;
  onSaveHeaderRules: (rules: TerminalBrowserHeaderRule[]) => Promise<boolean>;
  onOpenExternal: () => void;
}

export function TerminalBrowserSurface({
  containerRef,
  browserViewRef,
  isElectron,
  headerRulesPanelOpen,
  headerRules,
  devicePanelOpen,
  deviceState,
  deviceSwitching,
  mobileDisabledReason,
  headerSaving,
  headerError,
  onCloseHeaderRulesPanel,
  onCloseDevicePanel,
  onSelectDevicePreset,
  onSaveHeaderRules,
  onOpenExternal,
}: TerminalBrowserSurfaceProps) {
  const [mobileDisplaySize, setMobileDisplaySize] =
    useState<MobileDisplaySize | null>(null);
  const sidePanelOpen = headerRulesPanelOpen || devicePanelOpen;
  const lastMobileMeasureKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!deviceState.mobile || !deviceState.viewport) {
      setMobileDisplaySize(null);
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const sidePanelWidth = sidePanelOpen
        ? TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX
        : 0;
      const availableWidth = Math.max(
        1,
        rect.width -
          BROWSER_VIEW_GUTTER_PX -
          sidePanelWidth -
          MOBILE_STAGE_PADDING_PX * 2,
      );
      const availableHeight = Math.max(
        1,
        rect.height - MOBILE_STAGE_PADDING_PX * 2,
      );
      const scale = Math.max(
        MIN_MOBILE_SCALE,
        Math.min(1, availableWidth / deviceState.viewport!.width),
      );
      const nextDisplaySize = {
        width: Math.round(deviceState.viewport!.width * scale),
        height: Math.round(deviceState.viewport!.height * scale),
      };
      const measureKey = [
        deviceState.presetId,
        rect.width.toFixed(1),
        rect.height.toFixed(1),
        sidePanelWidth,
        availableWidth,
        availableHeight,
        scale.toFixed(4),
        nextDisplaySize.width,
        nextDisplaySize.height,
      ].join(":");
      if (lastMobileMeasureKeyRef.current !== measureKey) {
        lastMobileMeasureKeyRef.current = measureKey;
        aiDiagnosticLog("terminal browser mobile display measured", {
          presetId: deviceState.presetId,
          logicalWidth: deviceState.viewport!.width,
          logicalHeight: deviceState.viewport!.height,
          containerWidth: Math.round(rect.width),
          containerHeight: Math.round(rect.height),
          sidePanelWidth,
          availableWidth,
          availableHeight,
          scale,
          displayWidth: nextDisplaySize.width,
          displayHeight: nextDisplaySize.height,
          heightOverflow: nextDisplaySize.height > availableHeight,
        });
      }
      setMobileDisplaySize(nextDisplaySize);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, deviceState, sidePanelOpen]);

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1">
      {deviceState.mobile && mobileDisplaySize ? (
        <div
          className="absolute inset-y-0 right-0 flex items-start justify-center overflow-hidden"
          style={{
            left: BROWSER_VIEW_GUTTER_PX,
            right: sidePanelOpen ? TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX : 0,
            padding: MOBILE_STAGE_PADDING_PX,
          }}
        >
          <div
            ref={browserViewRef}
            className="overflow-hidden"
            style={{
              width: mobileDisplaySize.width,
              height: mobileDisplaySize.height,
            }}
          />
        </div>
      ) : (
        <div
          ref={browserViewRef}
          className="absolute inset-y-0 right-0"
          style={{
            left: BROWSER_VIEW_GUTTER_PX,
            right: sidePanelOpen ? TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX : 0,
          }}
        />
      )}
      {isElectron ? (
        <TerminalBrowserHeadersPanel
          open={headerRulesPanelOpen}
          rules={headerRules}
          saving={headerSaving}
          error={headerError}
          onClose={onCloseHeaderRulesPanel}
          onSave={onSaveHeaderRules}
        />
      ) : null}
      {isElectron ? (
        <TerminalBrowserDevicePanel
          open={devicePanelOpen}
          deviceState={deviceState}
          switching={deviceSwitching}
          mobileDisabledReason={mobileDisabledReason}
          onClose={onCloseDevicePanel}
          onSelectPreset={onSelectDevicePreset}
        />
      ) : null}
      {!isElectron ? (
        <div
          className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-xs text-slate-400"
          style={{ left: BROWSER_VIEW_GUTTER_PX }}
        >
          <Globe2 className="h-8 w-8 text-slate-500" />
          <p>Local browser is available in the desktop app.</p>
          <Button
            type="button"
            size="sm"
            className="rounded-md"
            onClick={onOpenExternal}
          >
            Open in system browser
          </Button>
        </div>
      ) : null}
    </div>
  );
}
