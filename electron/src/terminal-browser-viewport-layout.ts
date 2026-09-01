import type { BrowserWindow } from "electron";
import { getTerminalBrowserContentWidth } from "@runweave/shared/terminal-browser-minimum-width";
import type { TerminalBrowserBounds } from "@runweave/shared/desktop-bridge";
import type { TerminalBrowserEntry } from "./terminal-browser-runtime.js";
import { clampTerminalBrowserBounds } from "./terminal-browser-view-helpers.js";

function clampHorizontalOffset(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.round(value), maximum));
}

export function layoutTerminalBrowserViewport(
  win: BrowserWindow,
  entry: TerminalBrowserEntry,
  bounds: TerminalBrowserBounds,
): void {
  const viewportBounds = clampTerminalBrowserBounds(win, bounds);
  entry.viewportBounds = viewportBounds;
  relayoutTerminalBrowserViewport(entry, bounds.horizontalOffsetX);
}

export function relayoutTerminalBrowserViewport(
  entry: TerminalBrowserEntry,
  requestedHorizontalOffsetX: unknown = entry.horizontalOffsetX,
): void {
  const viewportBounds = entry.viewportBounds;
  if (!viewportBounds) {
    return;
  }
  const contentWidth = getTerminalBrowserContentWidth(
    viewportBounds.width,
    entry.minimumViewportWidth,
    entry.displayScale,
    entry.deviceState.mobile,
  );
  const maximumOffset = Math.max(0, contentWidth - viewportBounds.width);
  const horizontalOffsetX = entry.deviceState.mobile
    ? 0
    : clampHorizontalOffset(requestedHorizontalOffsetX, maximumOffset);

  entry.horizontalOffsetX = horizontalOffsetX;
  entry.viewportView.setBounds(viewportBounds);
  entry.view.setBounds({
    x: -horizontalOffsetX,
    y: 0,
    width: contentWidth,
    height: viewportBounds.height,
  });
}
