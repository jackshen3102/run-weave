export const TERMINAL_BROWSER_MINIMUM_VIEWPORT_WIDTHS = [
  768, 1024, 1440,
] as const;

export type TerminalBrowserMinimumViewportWidth =
  | (typeof TERMINAL_BROWSER_MINIMUM_VIEWPORT_WIDTHS)[number]
  | null;

export interface TerminalBrowserMinimumViewportWidthState {
  width: TerminalBrowserMinimumViewportWidth;
}

export function isTerminalBrowserMinimumViewportWidth(
  value: unknown,
): value is TerminalBrowserMinimumViewportWidth {
  return (
    value === null ||
    (typeof value === "number" &&
      TERMINAL_BROWSER_MINIMUM_VIEWPORT_WIDTHS.some((width) => width === value))
  );
}

export function getTerminalBrowserContentWidth(
  visibleWidth: number,
  minimumWidth: TerminalBrowserMinimumViewportWidth,
  displayScale: number,
  mobile: boolean,
): number {
  if (
    !Number.isFinite(visibleWidth) ||
    visibleWidth <= 0 ||
    !Number.isFinite(displayScale) ||
    displayScale <= 0
  ) {
    return 1;
  }
  const minimumPhysicalWidth =
    mobile || minimumWidth === null ? 0 : minimumWidth * displayScale;
  return Math.max(1, Math.round(Math.max(visibleWidth, minimumPhysicalWidth)));
}
