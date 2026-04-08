import type { ViewerTab } from "@browser-viewer/shared";
import type { Page } from "playwright";

export function inferTabFaviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export async function resolveTabFaviconUrl(page: Page): Promise<string | null> {
  try {
    const declaredHref = await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
      );
      return link?.getAttribute("href") ?? null;
    });

    if (declaredHref) {
      return new URL(declaredHref, page.url()).toString();
    }
  } catch {
    // Ignore DOM access failures and fall back to origin favicon below.
  }

  return inferTabFaviconUrl(page.url());
}

export function buildSessionTabFaviconPath(
  sessionId: string,
  tabId: string,
): string {
  return `/api/session/${encodeURIComponent(sessionId)}/tabs/${encodeURIComponent(tabId)}/favicon`;
}

export function buildTabsSnapshot(
  sessionId: string,
  pages: Page[],
  pageToTabId: WeakMap<Page, string>,
  tabTitleById: Map<string, string>,
  tabFaviconById: Map<string, string | null>,
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
      faviconUrl:
        (tabFaviconById.get(id) ?? inferTabFaviconUrl(page.url())) !== null
          ? buildSessionTabFaviconPath(sessionId, id)
          : null,
    });
  }

  return tabs;
}
