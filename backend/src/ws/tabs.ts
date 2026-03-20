import type { ViewerTab } from "@browser-viewer/shared";
import type { Page } from "playwright";

export function buildTabsSnapshot(
  tabIdToPage: Map<string, Page>,
  tabTitleById: Map<string, string>,
  activeTabId: string | null,
): ViewerTab[] {
  return Array.from(tabIdToPage.entries()).map(([id, page]) => ({
    id,
    url: page.url(),
    title: tabTitleById.get(id) ?? page.url(),
    active: id === activeTabId,
  }));
}
