import type { NavigationState } from "@browser-viewer/shared";
import type { BrowserContext, Page } from "playwright";

function hasScheme(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url);
}

export function normalizeNavigationUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url) {
    throw new Error("URL is required");
  }
  return hasScheme(url) ? url : `https://${url}`;
}

export async function getNavigationHistory(
  context: BrowserContext,
  page: Page,
): Promise<{ currentIndex: number; entryCount: number } | null> {
  const tempSession = await context.newCDPSession(page);
  try {
    const history = (await tempSession.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: Array<unknown>;
    };
    return {
      currentIndex: history.currentIndex,
      entryCount: history.entries.length,
    };
  } catch {
    return null;
  } finally {
    await tempSession.detach().catch(() => undefined);
  }
}

export async function getNavigationCapability(
  context: BrowserContext,
  page: Page,
): Promise<Pick<NavigationState, "canGoBack" | "canGoForward">> {
  const history = await getNavigationHistory(context, page);
  if (!history) {
    return { canGoBack: false, canGoForward: false };
  }

  return {
    canGoBack: history.currentIndex > 0,
    canGoForward: history.currentIndex < history.entryCount - 1,
  };
}

export async function stopPageLoading(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const tempSession = await context.newCDPSession(page);
  try {
    await tempSession.send("Page.stopLoading");
  } finally {
    await tempSession.detach().catch(() => undefined);
  }
}
