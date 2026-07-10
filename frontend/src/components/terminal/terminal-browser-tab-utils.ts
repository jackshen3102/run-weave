import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";

export const TERMINAL_BROWSER_TAB_PREFERRED_WIDTH = 180;
export const TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH = 80;
export const TERMINAL_BROWSER_INACTIVE_TAB_MIN_WIDTH = 44;
export const TERMINAL_BROWSER_TAB_GAP = 4;

const BROWSER_GROUP_COLORS = [
  "#38bdf8",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#a78bfa",
  "#2dd4bf",
  "#fb7185",
  "#84cc16",
  "#60a5fa",
  "#f87171",
  "#22c55e",
  "#e879f9",
  "#06b6d4",
  "#f97316",
  "#c084fc",
  "#14b8a6",
  "#eab308",
  "#ec4899",
  "#10b981",
  "#818cf8",
  "#ef4444",
  "#65a30d",
  "#d946ef",
  "#0ea5e9",
];

export function browserTabLabel(title: string, url: string): string {
  const normalizedUrl = url === "about:blank" ? "" : url;
  return title.trim() || normalizedUrl.replace(/^https?:\/\//, "") || "New Tab";
}

export function getBrowserGroupColor(browserGroupId?: string): string {
  if (!browserGroupId) {
    return "#64748b";
  }
  let hash = 0;
  for (let index = 0; index < browserGroupId.length; index += 1) {
    hash = (hash * 31 + browserGroupId.charCodeAt(index)) >>> 0;
  }
  return BROWSER_GROUP_COLORS[hash % BROWSER_GROUP_COLORS.length]!;
}

export function getBrowserGroupLabel(browserGroupId?: string): string {
  if (!browserGroupId) {
    return "Group pending";
  }
  return `Group ${browserGroupId.slice(-6)}`;
}

export function calculateTerminalBrowserTabWidths(
  tabs: Pick<TerminalBrowserTabState, "id">[],
  activeTabId: string,
  viewportWidth: number,
): Record<string, number> {
  if (tabs.length === 0) {
    return {};
  }

  const gapTotal = TERMINAL_BROWSER_TAB_GAP * Math.max(0, tabs.length - 1);
  const preferredTotal = TERMINAL_BROWSER_TAB_PREFERRED_WIDTH * tabs.length + gapTotal;
  let activeWidth = TERMINAL_BROWSER_TAB_PREFERRED_WIDTH;
  let inactiveWidth = TERMINAL_BROWSER_TAB_PREFERRED_WIDTH;

  if (preferredTotal > viewportWidth) {
    const equalWidth = (viewportWidth - gapTotal) / tabs.length;
    if (equalWidth >= TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH) {
      activeWidth = equalWidth;
      inactiveWidth = equalWidth;
    } else if (
      tabs.length > 1 &&
      TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH +
        TERMINAL_BROWSER_INACTIVE_TAB_MIN_WIDTH * (tabs.length - 1) +
        gapTotal <=
        viewportWidth
    ) {
      activeWidth = TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH;
      inactiveWidth =
        (viewportWidth - gapTotal - TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH) /
        (tabs.length - 1);
    } else {
      activeWidth = TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH;
      inactiveWidth = TERMINAL_BROWSER_INACTIVE_TAB_MIN_WIDTH;
    }
  }

  return Object.fromEntries(
    tabs.map((tab) => [
      tab.id,
      tab.id === activeTabId ? activeWidth : inactiveWidth,
    ]),
  );
}

export type TerminalBrowserTabDensity =
  | "comfortable"
  | "compact"
  | "icon-only";

export function getTerminalBrowserTabDensity(
  width: number,
): TerminalBrowserTabDensity {
  if (width > 95) {
    return "comfortable";
  }
  if (width >= 64) {
    return "compact";
  }
  return "icon-only";
}
