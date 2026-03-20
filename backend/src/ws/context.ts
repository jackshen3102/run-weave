import type { CDPSession, Frame, Page } from "playwright";

export interface PageListeners {
  close: () => void;
  framenavigated: (frame: Frame) => void;
  load: () => void;
}

export interface ConnectionContext {
  cdpSession: CDPSession | null;
  heartbeatTimer: NodeJS.Timeout | null;
  isAlive: boolean;
  isClosed: boolean;
  activePage: Page;
  activeTabId: string | null;
  tabCounter: number;
  cursorLookupTimer: NodeJS.Timeout | null;
  cursorLookupInFlight: boolean;
  pendingCursorPoint: { x: number; y: number } | null;
  lastCursorLookupAt: number;
  lastCursorValue: string;
  tabIdToPage: Map<string, Page>;
  pageToTabId: WeakMap<Page, string>;
  tabTitleById: Map<string, string>;
  pageListenersByTabId: Map<string, PageListeners>;
  tabLoadingById: Map<string, boolean>;
}

export function createConnectionContext(initialPage: Page): ConnectionContext {
  return {
    cdpSession: null,
    heartbeatTimer: null,
    isAlive: true,
    isClosed: false,
    activePage: initialPage,
    activeTabId: null,
    tabCounter: 0,
    cursorLookupTimer: null,
    cursorLookupInFlight: false,
    pendingCursorPoint: null,
    lastCursorLookupAt: 0,
    lastCursorValue: "default",
    tabIdToPage: new Map<string, Page>(),
    pageToTabId: new WeakMap<Page, string>(),
    tabTitleById: new Map<string, string>(),
    pageListenersByTabId: new Map<string, PageListeners>(),
    tabLoadingById: new Map<string, boolean>(),
  };
}
