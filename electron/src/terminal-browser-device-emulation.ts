import type { WebContentsView } from "electron";
import { createTerminalBrowserDeviceState, getTerminalBrowserDevicePreset, type TerminalBrowserDevicePresetId, type TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";

export interface TerminalBrowserDeviceEmulationEntry {
  view: WebContentsView;
  targetId: string;
  cdpProxyAttached: boolean;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
  emulationScale: number;
  defaultUserAgent: string;
  deviceDebuggerAttached: boolean;
  onDeviceDebuggerDetach: ((event: Electron.Event, reason: string) => void) | null;
}

export function getTerminalBrowserDeviceState(
  entry: TerminalBrowserDeviceEmulationEntry,
): TerminalBrowserDeviceState {
  return createTerminalBrowserDeviceState(entry.deviceState.presetId);
}

export function isTerminalBrowserMobileDeviceState(
  entry: TerminalBrowserDeviceEmulationEntry,
): boolean {
  return entry.deviceState.mobile === true;
}

export function clampTerminalBrowserEmulationScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(0.1, Math.min(value, 1));
}

export function attachTerminalBrowserDeviceDebugger(
  entry: TerminalBrowserDeviceEmulationEntry,
): void {
  if (entry.deviceDebuggerAttached) {
    return;
  }
  const webContents = entry.view.webContents;
  if (webContents.isDestroyed()) {
    throw new Error("Cannot emulate a closed browser tab");
  }
  if (entry.devtoolsOpen || webContents.isDevToolsOpened()) {
    throw new Error("Cannot enable mobile mode while DevTools is open");
  }
  if (!entry.cdpProxyAttached) {
    try {
      webContents.debugger.attach("1.3");
    } catch (error) {
      throw new Error(
        `Cannot enable mobile mode because the debugger is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  entry.deviceDebuggerAttached = true;
  entry.onDeviceDebuggerDetach = (_event, reason) => {
    entry.deviceDebuggerAttached = false;
    entry.onDeviceDebuggerDetach = null;
    console.info("[electron] terminal browser device debugger detached", {
      targetId: entry.targetId,
      reason,
    });
  };
  webContents.debugger.on("detach", entry.onDeviceDebuggerDetach);
}

export function detachTerminalBrowserDeviceDebugger(
  entry: TerminalBrowserDeviceEmulationEntry,
): void {
  if (!entry.deviceDebuggerAttached) {
    return;
  }
  const webContents = entry.view.webContents;
  if (entry.onDeviceDebuggerDetach) {
    webContents.debugger.off("detach", entry.onDeviceDebuggerDetach);
    entry.onDeviceDebuggerDetach = null;
  }
  if (!entry.cdpProxyAttached) {
    try {
      webContents.debugger.detach();
    } catch {
      // Already detached.
    }
  }
  entry.deviceDebuggerAttached = false;
}

export async function applyTerminalBrowserDeviceEmulation(
  entry: TerminalBrowserDeviceEmulationEntry,
  presetId: TerminalBrowserDevicePresetId,
): Promise<TerminalBrowserDeviceState> {
  const preset = getTerminalBrowserDevicePreset(presetId);
  const webContents = entry.view.webContents;
  if (webContents.isDestroyed()) {
    throw new Error("Cannot update a closed browser tab");
  }

  if (!preset.mobile) {
    if (entry.deviceState.mobile) {
      await webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await webContents.debugger.sendCommand("Network.setUserAgentOverride", {
        userAgent: entry.defaultUserAgent,
      });
    }
    if (entry.deviceDebuggerAttached) {
      detachTerminalBrowserDeviceDebugger(entry);
    }
    webContents.setUserAgent(entry.defaultUserAgent);
    entry.emulationScale = 1;
    const state = createTerminalBrowserDeviceState("desktop");
    entry.deviceState = state;
    return state;
  }

  if (entry.devtoolsOpen || webContents.isDevToolsOpened()) {
    throw new Error("Cannot enable mobile mode while DevTools is open");
  }

  const viewport = preset.viewport;
  if (!viewport || !preset.userAgent) {
    throw new Error("Invalid terminal browser device preset");
  }

  attachTerminalBrowserDeviceDebugger(entry);
  webContents.setUserAgent(preset.userAgent);
  await webContents.debugger.sendCommand("Network.setUserAgentOverride", {
    userAgent: preset.userAgent,
    platform: preset.id === "pixel-7" ? "Android" : "iPhone",
  });
  await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: true,
    scale: entry.emulationScale,
  });
  await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    configuration: "mobile",
  });

  const state = createTerminalBrowserDeviceState(preset.id);
  entry.deviceState = state;
  return state;
}

export async function updateTerminalBrowserEmulationScale(
  entry: TerminalBrowserDeviceEmulationEntry,
  emulationScale: number,
): Promise<void> {
  entry.emulationScale = clampTerminalBrowserEmulationScale(emulationScale);
  if (!entry.deviceState.mobile) {
    return;
  }
  await applyTerminalBrowserDeviceEmulation(entry, entry.deviceState.presetId);
}
