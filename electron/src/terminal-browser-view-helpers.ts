import type { BrowserWindow } from "electron";
import { normalizeTerminalBrowserUrlForStorage } from "./terminal-browser-tabs-state.js";
import { findTerminalBrowserEntryForWindow } from "./terminal-browser-runtime.js";
import type {
  TerminalBrowserBounds,
  TerminalBrowserEntry,
} from "./terminal-browser-runtime.js";

export function isTerminalBrowserBounds(
  value: unknown,
): value is TerminalBrowserBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const hasBounds = ["x", "y", "width", "height"].every(
    (key) =>
      typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
  );
  if (!hasBounds) {
    return false;
  }
  return (
    (candidate.emulationScale === undefined ||
      (typeof candidate.emulationScale === "number" &&
        Number.isFinite(candidate.emulationScale) &&
        candidate.emulationScale > 0)) &&
    (candidate.horizontalOffsetX === undefined ||
      (typeof candidate.horizontalOffsetX === "number" &&
        Number.isFinite(candidate.horizontalOffsetX) &&
        candidate.horizontalOffsetX >= 0))
  );
}

export function validateTerminalBrowserUrl(url: string): string | null {
  return normalizeTerminalBrowserUrlForStorage(url);
}

export function getExistingTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  action: string,
): TerminalBrowserEntry {
  const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
  if (!entry) {
    throw new Error(`Cannot ${action} closed browser tab`);
  }
  return entry;
}

export function clampTerminalBrowserBounds(
  win: BrowserWindow,
  bounds: TerminalBrowserBounds,
): TerminalBrowserBounds {
  const content = win.getContentBounds();
  const maxWidth = Math.max(0, content.width - bounds.x);
  const maxHeight = Math.max(0, content.height - bounds.y);
  return {
    x: Math.max(0, Math.min(Math.round(bounds.x), content.width)),
    y: Math.max(0, Math.min(Math.round(bounds.y), content.height)),
    width: Math.max(0, Math.min(Math.round(bounds.width), maxWidth)),
    height: Math.max(0, Math.min(Math.round(bounds.height), maxHeight)),
  };
}
