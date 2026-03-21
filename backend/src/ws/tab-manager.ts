import type { BrowserContext, Frame, Page } from "playwright";
import type { ConnectionContext } from "./context";

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
  registerPage: (page: Page) => string;
  onContextPage: (page: Page) => void;
  initializeTabs: (primaryPage: Page) => void;
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

  const refreshTabTitle = async (tabId: string, page: Page): Promise<void> => {
    try {
      const title = await page.title();
      state.tabTitleById.set(tabId, title || page.url());
    } catch {
      state.tabTitleById.set(tabId, page.url());
    }
    emitTabs();
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
    const fallbackTabId = Array.from(state.tabIdToPage.keys()).at(-1);
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
    state.tabIdToPage.delete(tabId);
    state.tabTitleById.delete(tabId);
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

  const registerPage = (page: Page): string => {
    const existing = state.pageToTabId.get(page);
    if (existing) {
      return existing;
    }

    const tabId = `tab-${++state.tabCounter}`;
    state.pageToTabId.set(page, tabId);
    state.tabIdToPage.set(tabId, page);
    state.tabTitleById.set(tabId, page.url() || "about:blank");
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
      void refreshTabTitle(tabId, page);
      void emitNavigationState(tabId);
    };

    state.pageListenersByTabId.set(tabId, { close, framenavigated, load });
    page.on("close", close);
    page.on("framenavigated", framenavigated);
    page.on("load", load);

    void refreshTabTitle(tabId, page);
    emitTabs();
    return tabId;
  };

  const onContextPage = (page: Page): void => {
    const tabId = registerPage(page);
    void selectTab(tabId).catch((error) => {
      sendError(String(error));
    });
  };

  const createTab = async (): Promise<void> => {
    const page = await context.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  };

  const initializeTabs = (primaryPage: Page): void => {
    for (const page of context.pages()) {
      registerPage(page);
    }
    const initialTabId =
      state.pageToTabId.get(primaryPage) ??
      Array.from(state.tabIdToPage.keys())[0];
    if (initialTabId) {
      state.activeTabId = initialTabId;
      state.activePage =
        state.tabIdToPage.get(initialTabId) ?? state.activePage;
    }
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
    registerPage,
    onContextPage,
    initializeTabs,
    disposePageListeners,
  };
}
