import type { ViewerTab } from "@browser-viewer/shared";
import type { Page } from "playwright";

export function buildTabsSnapshot(
  pages: Page[],
  pageToTabId: WeakMap<Page, string>,
  tabTitleById: Map<string, string>,
  activeTabId: string | null,
): ViewerTab[] {
  const tabs: ViewerTab[] = [];

  for (const page of pages) {
    const id = pageToTabId.get(page);
    if (!id) {
      continue;
    }

    tabs.push({
      id,
      url: page.url(),
      title: tabTitleById.get(id) ?? page.url(),
      active: id === activeTabId,
    });
  }

  return tabs;
}
