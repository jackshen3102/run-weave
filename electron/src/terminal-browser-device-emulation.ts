import { createTerminalBrowserDeviceState, getTerminalBrowserDevicePreset, type TerminalBrowserDevicePresetId, type TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import {
  ensureTerminalBrowserMetricsDebugger,
  reapplyTerminalBrowserDisplayMetrics,
  releaseTerminalBrowserMetricsDebugger,
  type TerminalBrowserDisplayScaleEntry,
} from "./terminal-browser-display-scale.js";

export interface TerminalBrowserDeviceEmulationEntry
  extends TerminalBrowserDisplayScaleEntry {
  devtoolsOpen: boolean;
  defaultUserAgent: string;
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
  if (entry.devtoolsOpen || entry.view.webContents.isDevToolsOpened()) {
    throw new Error("Cannot enable mobile mode while DevTools is open");
  }
  ensureTerminalBrowserMetricsDebugger(entry);
}

export function detachTerminalBrowserDeviceDebugger(
  entry: TerminalBrowserDeviceEmulationEntry,
): void {
  releaseTerminalBrowserMetricsDebugger(entry);
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
      attachTerminalBrowserDeviceDebugger(entry);
      await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await webContents.debugger.sendCommand("Network.setUserAgentOverride", {
        userAgent: entry.defaultUserAgent,
      });
    }
    webContents.setUserAgent(entry.defaultUserAgent);
    const previousState = entry.deviceState;
    const previousEmulationScale = entry.emulationScale;
    entry.emulationScale = 1;
    const state = createTerminalBrowserDeviceState("desktop");
    entry.deviceState = state;
    try {
      await reapplyTerminalBrowserDisplayMetrics(entry);
    } catch (error) {
      entry.deviceState = previousState;
      entry.emulationScale = previousEmulationScale;
      throw error;
    }
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
  await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    configuration: "mobile",
  });

  const previousState = entry.deviceState;
  const state = createTerminalBrowserDeviceState(preset.id);
  entry.deviceState = state;
  try {
    await reapplyTerminalBrowserDisplayMetrics(entry);
  } catch (error) {
    entry.deviceState = previousState;
    throw error;
  }
  return state;
}

export async function updateTerminalBrowserEmulationScale(
  entry: TerminalBrowserDeviceEmulationEntry,
  emulationScale: number,
): Promise<void> {
  const previousEmulationScale = entry.emulationScale;
  entry.emulationScale = clampTerminalBrowserEmulationScale(emulationScale);
  try {
    await reapplyTerminalBrowserDisplayMetrics(entry);
  } catch (error) {
    entry.emulationScale = previousEmulationScale;
    throw error;
  }
}
