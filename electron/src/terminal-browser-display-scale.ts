import type { WebContentsView } from "electron";
import {
  DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
  isTerminalBrowserDisplayScale,
  type TerminalBrowserDisplayScaleState,
} from "@runweave/shared/terminal-browser-display-scale";
import {
  getTerminalBrowserDevicePreset,
  type TerminalBrowserDeviceState,
} from "@runweave/shared/terminal-browser-device";

type DeviceMetricsParams = Record<string, unknown>;
type MetricsCommandSender = (
  method: string,
  params: DeviceMetricsParams,
) => Promise<object>;

export interface TerminalBrowserDisplayScaleEntry {
  view: WebContentsView;
  targetId: string;
  cdpProxyAttached: boolean;
  deviceState: TerminalBrowserDeviceState;
  displayScale: number;
  emulationScale: number;
  automationDeviceMetrics: DeviceMetricsParams | null;
  metricsMutationQueue: Promise<void>;
  metricsMutationClosed: boolean;
  deviceDebuggerAttached: boolean;
  onDeviceDebuggerDetach:
    | ((event: Electron.Event, reason: string) => void)
    | null;
}

function enqueueMetricsMutation<T>(
  entry: TerminalBrowserDisplayScaleEntry,
  mutation: () => Promise<T>,
): Promise<T> {
  const result = entry.metricsMutationQueue.then(async () => {
    if (entry.metricsMutationClosed || entry.view.webContents.isDestroyed()) {
      throw new Error("Cannot update a closed browser tab");
    }
    return await mutation();
  });
  entry.metricsMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function getRawMetricsScale(params: DeviceMetricsParams): number {
  const scale = params.scale;
  return typeof scale === "number" && Number.isFinite(scale)
    ? scale
    : 1;
}

function buildEffectiveDeviceMetrics(
  entry: TerminalBrowserDisplayScaleEntry,
  displayScale: number,
  automationMetrics = entry.automationDeviceMetrics,
): DeviceMetricsParams | null {
  if (automationMetrics) {
    return {
      ...automationMetrics,
      scale: getRawMetricsScale(automationMetrics) * displayScale,
    };
  }

  if (entry.deviceState.mobile) {
    const preset = getTerminalBrowserDevicePreset(entry.deviceState.presetId);
    const viewport = preset.viewport;
    if (!viewport) {
      throw new Error("Invalid terminal browser device preset");
    }
    return {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: true,
      scale: entry.emulationScale * displayScale,
    };
  }

  if (displayScale === DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE) {
    return null;
  }

  const bounds = entry.view.getBounds();
  return {
    width: Math.max(1, Math.round(bounds.width / displayScale)),
    height: Math.max(1, Math.round(bounds.height / displayScale)),
    deviceScaleFactor: 0,
    mobile: false,
    scale: displayScale,
  };
}

function getDefaultMetricsCommandSender(
  entry: TerminalBrowserDisplayScaleEntry,
): MetricsCommandSender {
  return async (method, params) => {
    const result = await entry.view.webContents.debugger.sendCommand(
      method,
      params,
    );
    return (result as object | undefined) ?? {};
  };
}

async function sendEffectiveDisplayMetrics(
  entry: TerminalBrowserDisplayScaleEntry,
  sender: MetricsCommandSender,
  displayScale: number,
  automationMetrics = entry.automationDeviceMetrics,
): Promise<void> {
  const metrics = buildEffectiveDeviceMetrics(
    entry,
    displayScale,
    automationMetrics,
  );
  if (metrics) {
    await sender("Emulation.setDeviceMetricsOverride", metrics);
    return;
  }
  await sender("Emulation.clearDeviceMetricsOverride", {});
}

async function waitForTerminalBrowserPaint(
  sender: MetricsCommandSender,
): Promise<void> {
  await sender("Runtime.evaluate", {
    expression:
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
    returnByValue: true,
  });
}

export function ensureTerminalBrowserMetricsDebugger(
  entry: TerminalBrowserDisplayScaleEntry,
): void {
  if (entry.deviceDebuggerAttached) {
    return;
  }
  const webContents = entry.view.webContents;
  if (webContents.isDestroyed()) {
    throw new Error("Cannot update a closed browser tab");
  }
  if (!entry.cdpProxyAttached) {
    try {
      webContents.debugger.attach("1.3");
    } catch (error) {
      throw new Error(
        `Cannot update browser display because the debugger is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  entry.deviceDebuggerAttached = true;
  entry.onDeviceDebuggerDetach = (_event, reason) => {
    entry.deviceDebuggerAttached = false;
    entry.onDeviceDebuggerDetach = null;
    console.info("[electron] terminal browser metrics debugger detached", {
      targetId: entry.targetId,
      reason,
    });
  };
  webContents.debugger.on("detach", entry.onDeviceDebuggerDetach);
}

export function releaseTerminalBrowserMetricsDebugger(
  entry: TerminalBrowserDisplayScaleEntry,
): void {
  if (!entry.deviceDebuggerAttached) {
    return;
  }
  const webContents = entry.view.webContents;
  if (entry.onDeviceDebuggerDetach && !webContents.isDestroyed()) {
    webContents.debugger.off("detach", entry.onDeviceDebuggerDetach);
  }
  entry.onDeviceDebuggerDetach = null;
  if (!entry.cdpProxyAttached && !webContents.isDestroyed()) {
    try {
      webContents.debugger.detach();
    } catch {
      // Already detached.
    }
  }
  entry.deviceDebuggerAttached = false;
}

function canReleaseMetricsDebugger(
  entry: TerminalBrowserDisplayScaleEntry,
): boolean {
  return (
    entry.displayScale === DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE &&
    !entry.deviceState.mobile &&
    entry.automationDeviceMetrics === null
  );
}

export async function setTerminalBrowserDisplayScale(
  entry: TerminalBrowserDisplayScaleEntry,
  factor: unknown,
): Promise<TerminalBrowserDisplayScaleState> {
  if (!isTerminalBrowserDisplayScale(factor)) {
    throw new Error("Invalid terminal browser display scale");
  }
  return await enqueueMetricsMutation(entry, async () => {
    if (entry.displayScale === factor) {
      return { factor };
    }
    const wasDebuggerAttached = entry.deviceDebuggerAttached;
    ensureTerminalBrowserMetricsDebugger(entry);
    try {
      await sendEffectiveDisplayMetrics(
        entry,
        getDefaultMetricsCommandSender(entry),
        factor,
      );
    } catch (error) {
      if (!wasDebuggerAttached) {
        releaseTerminalBrowserMetricsDebugger(entry);
      }
      throw error;
    }

    entry.displayScale = factor;
    if (canReleaseMetricsDebugger(entry)) {
      releaseTerminalBrowserMetricsDebugger(entry);
    }
    return { factor };
  });
}

export async function reapplyTerminalBrowserDisplayMetrics(
  entry: TerminalBrowserDisplayScaleEntry,
): Promise<void> {
  await enqueueMetricsMutation(entry, async () => {
    const metrics = buildEffectiveDeviceMetrics(entry, entry.displayScale);
    if (!metrics && !entry.deviceDebuggerAttached && !entry.cdpProxyAttached) {
      return;
    }
    ensureTerminalBrowserMetricsDebugger(entry);
    await sendEffectiveDisplayMetrics(
      entry,
      getDefaultMetricsCommandSender(entry),
      entry.displayScale,
    );
    if (canReleaseMetricsDebugger(entry)) {
      releaseTerminalBrowserMetricsDebugger(entry);
    }
  });
}

export async function sendTerminalBrowserAutomationMetricsCommand(
  entry: TerminalBrowserDisplayScaleEntry,
  method: "Emulation.setDeviceMetricsOverride" | "Emulation.clearDeviceMetricsOverride",
  params: DeviceMetricsParams,
  sender: MetricsCommandSender,
): Promise<object> {
  return await enqueueMetricsMutation(entry, async () => {
    if (method === "Emulation.setDeviceMetricsOverride") {
      const rawMetrics = { ...params };
      const result = await sender(
        method,
        buildEffectiveDeviceMetrics(entry, entry.displayScale, rawMetrics)!,
      );
      entry.automationDeviceMetrics = rawMetrics;
      return result;
    }

    const result = await sender(method, {});
    entry.automationDeviceMetrics = null;
    const fallback = buildEffectiveDeviceMetrics(entry, entry.displayScale);
    if (fallback) {
      await sender("Emulation.setDeviceMetricsOverride", fallback);
    }
    if (canReleaseMetricsDebugger(entry)) {
      releaseTerminalBrowserMetricsDebugger(entry);
    }
    return result;
  });
}

export async function captureTerminalBrowserScreenshot(
  entry: TerminalBrowserDisplayScaleEntry,
  params: DeviceMetricsParams,
  sender: MetricsCommandSender,
): Promise<object> {
  if (entry.displayScale === DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE) {
    return await sender("Page.captureScreenshot", params);
  }

  return await enqueueMetricsMutation(entry, async () => {
    await sendEffectiveDisplayMetrics(
      entry,
      sender,
      DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
    );
    try {
      await waitForTerminalBrowserPaint(sender);
      return await sender("Page.captureScreenshot", params);
    } finally {
      await sendEffectiveDisplayMetrics(entry, sender, entry.displayScale);
      await waitForTerminalBrowserPaint(sender);
    }
  });
}

export async function getTerminalBrowserAutomationLayoutMetrics(
  entry: TerminalBrowserDisplayScaleEntry,
  params: DeviceMetricsParams,
  sender: MetricsCommandSender,
): Promise<object> {
  if (entry.displayScale === DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE) {
    return await sender("Page.getLayoutMetrics", params);
  }

  return await enqueueMetricsMutation(entry, async () => {
    await sendEffectiveDisplayMetrics(
      entry,
      sender,
      DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
    );
    try {
      return await sender("Page.getLayoutMetrics", params);
    } finally {
      await sendEffectiveDisplayMetrics(entry, sender, entry.displayScale);
    }
  });
}

export function closeTerminalBrowserDisplayScale(
  entry: TerminalBrowserDisplayScaleEntry,
): void {
  entry.metricsMutationClosed = true;
  entry.automationDeviceMetrics = null;
  releaseTerminalBrowserMetricsDebugger(entry);
}
