import type { BrowserContext, Frame, Page } from "playwright";
import type { ConnectionContext } from "./context";
import { resolvePageTargetId } from "./tab-target";
import { resolveTabFaviconUrl } from "./tabs";

interface TabManagerDeps {
  state: ConnectionContext;
  context: BrowserContext;
  emitTabs: () => void;
  emitCursor: (cursor: string) => void;
  emitNavigationState: (tabId: string) => Promise<void>;
  startScreencast: () => Promise<void>;
  stopScreencast: () => Promise<void>;
  sendError: (message: string) => void;
}

export function createTabManager(deps: TabManagerDeps): {
  selectTab: (tabId: string) => Promise<boolean>;
  createTab: () => Promise<void>;
  closeTab: (tabId: string) => Promise<boolean>;
  registerPage: (page: Page) => Promise<string | null>;
  onContextPage: (page: Page) => void;
  initializeTabs: (primaryPage: Page) => Promise<void>;
  disposePageListeners: () => void;
} {
  const {
    state,
    context,
    emitTabs,
    emitCursor,
    emitNavigationState,
    startScreencast,
    stopScreencast,
    sendError,
  } = deps;

  const refreshTabMetadata = async (
    tabId: string,
    page: Page,
    options?: { suppressEmit?: boolean },
  ): Promise<void> => {
    try {
      const title = await page.title();
      state.tabTitleById.set(tabId, title || page.url());
    } catch {
      state.tabTitleById.set(tabId, page.url());
    }

    try {
      state.tabFaviconById.set(tabId, await resolveTabFaviconUrl(page));
    } catch {
      state.tabFaviconById.set(tabId, null);
    }

    if (!options?.suppressEmit) {
      emitTabs();
    }
  };

  const selectTab = async (tabId: string): Promise<boolean> => {
    const nextPage = state.tabIdToPage.get(tabId);
    if (!nextPage) {
      return false;
    }

    state.activeTabId = tabId;
    state.activePage = nextPage;
    emitTabs();
    await emitNavigationState(tabId);

    await stopScreencast();
    await startScreencast();
    emitCursor("default");
    return true;
  };

  const selectLastTab = async (): Promise<void> => {
    const pages = context.pages();
    const fallbackPage = pages.at(-1);
    const fallbackTabId = fallbackPage
      ? (state.pageToTabId.get(fallbackPage) ?? null)
      : null;
    if (!fallbackTabId) {
      state.activeTabId = null;
      emitTabs();
      await stopScreencast();
      return;
    }
    await selectTab(fallbackTabId);
  };

  const unregisterPage = (tabId: string): void => {
    const page = state.tabIdToPage.get(tabId);
    if (!page) {
      return;
    }

    const listeners = state.pageListenersByTabId.get(tabId);
    if (listeners) {
      page.off("close", listeners.close);
      page.off("framenavigated", listeners.framenavigated);
      page.off("load", listeners.load);
    }

    state.pageListenersByTabId.delete(tabId);
    state.pageToTabId.delete(page);
    state.tabIdToPage.delete(tabId);
    state.tabTitleById.delete(tabId);
    state.tabFaviconById.delete(tabId);
    state.tabLoadingById.delete(tabId);
    state.devtoolsByTabId.delete(tabId);

    if (state.activeTabId === tabId && !state.isClosed) {
      void selectLastTab().catch((error) => {
        sendError(String(error));
      });
    } else {
      emitTabs();
    }
  };

  const registerPage = async (
    page: Page,
    options?: { suppressEmit?: boolean },
  ): Promise<string | null> => {
    const existing = state.pageToTabId.get(page);
    if (existing) {
      return existing;
    }

    const tabId = await resolvePageTargetId(context, page);
    if (!tabId) {
      return null;
    }

    state.pageToTabId.set(page, tabId);
    state.tabIdToPage.set(tabId, page);
    state.tabTitleById.set(tabId, page.url() || "about:blank");
    state.tabFaviconById.set(tabId, null);
    state.tabLoadingById.set(tabId, false);

    const close = (): void => {
      unregisterPage(tabId);
    };
    const framenavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) {
        state.tabLoadingById.set(tabId, true);
        emitTabs();
        void emitNavigationState(tabId);
      }
    };
    const load = (): void => {
      state.tabLoadingById.set(tabId, false);
      void refreshTabMetadata(tabId, page);
      void emitNavigationState(tabId);
    };

    state.pageListenersByTabId.set(tabId, { close, framenavigated, load });
    page.on("close", close);
    page.on("framenavigated", framenavigated);
    page.on("load", load);

    await refreshTabMetadata(tabId, page, options);
    if (!options?.suppressEmit) {
      emitTabs();
    }
    return tabId;
  };

  const onContextPage = (page: Page): void => {
    void registerPage(page)
      .then((tabId) => {
        if (!tabId) {
          return;
        }
        return selectTab(tabId);
      })
      .catch((error) => {
        sendError(String(error));
      });
  };

  const createTab = async (): Promise<void> => {
    const page = await context.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  };

  const closeTab = async (tabId: string): Promise<boolean> => {
    const page = state.tabIdToPage.get(tabId);
    if (!page) {
      return false;
    }

    await page.close();
    return true;
  };

  const initializeTabs = async (primaryPage: Page): Promise<void> => {
    await Promise.all(
      context.pages().map((page) => registerPage(page, { suppressEmit: true })),
    );

    const firstPage = context.pages().at(0);
    const initialTabId =
      state.pageToTabId.get(primaryPage) ??
      (firstPage ? state.pageToTabId.get(firstPage) : undefined);
    if (initialTabId) {
      state.activeTabId = initialTabId;
      state.activePage =
        state.tabIdToPage.get(initialTabId) ?? state.activePage;
    }

    emitTabs();
  };

  const disposePageListeners = (): void => {
    for (const [tabId, listeners] of state.pageListenersByTabId.entries()) {
      const page = state.tabIdToPage.get(tabId);
      if (!page) {
        continue;
      }
      page.off("close", listeners.close);
      page.off("framenavigated", listeners.framenavigated);
      page.off("load", listeners.load);
    }
    state.pageListenersByTabId.clear();
  };

  return {
    selectTab,
    createTab,
    closeTab,
    registerPage,
    onContextPage,
    initializeTabs,
    disposePageListeners,
  };
}
