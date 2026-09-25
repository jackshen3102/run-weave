import { useSyncExternalStore } from "react";
import type { TerminalBrowserBounds, TerminalBrowserPresentationState } from "@runweave/shared/desktop-bridge";
import { getOverlaySuppressed, setOverlayReady, setOverlayViewport, subscribeOverlays } from "../../overlay/registry";

let active = false;
let tabId: string | null = null;
let bounds: TerminalBrowserBounds | null = null;
let revision = 0;
let lastKey = "";
let error: string | null = null;
let pending: Promise<void> = Promise.resolve();
let acceptanceTransport: ((state: TerminalBrowserPresentationState) => Promise<void>) | null = null;
export function setPresentationAcceptanceTransport(transport: typeof acceptanceTransport): void {
  if (!import.meta.env.DEV && import.meta.env.VITE_RUNWEAVE_CHANNEL !== "beta") return;
  acceptanceTransport = transport;
}

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getError = () => error;
function reportError(next: string | null): void {
  error = next;
  for (const listener of listeners) listener();
}
function bounded<T>(request: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("浏览器呈现请求超时")), 1500);
    request.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
function sync(force = false): Promise<void> {
  const api = window.electronAPI;
  if (!api?.isElectron) { setOverlayReady(true); return Promise.resolve(); }
  const suppressed = getOverlaySuppressed();
  const key = `${active}:${suppressed}:${tabId}`;
  if (!force && key === lastKey) return pending;
  lastKey = key;
  const current = ++revision;
  const selected = tabId;
  const shouldHide = !active || suppressed;
  pending = (async () => {
    try {
      if (api.terminalBrowserSetPresentation) {
        const state = { revision: current, active, suppressed };
        if (!shouldHide && selected && bounds) {
          await bounded(api.terminalBrowserSetBounds!(selected, bounds));
        }
        if (revision !== current) return;
        const send = acceptanceTransport ?? api.terminalBrowserSetPresentation;
        try { await bounded(send(state)); }
        catch { await bounded(send(state)); }
        if (!shouldHide && selected && revision === current) {
          await bounded(api.terminalBrowserShow!(selected));
        }
      } else if (selected) {
        if (shouldHide) await bounded(api.terminalBrowserHide!(selected));
        else {
          if (bounds) await bounded(api.terminalBrowserSetBounds!(selected, bounds));
          await bounded(api.terminalBrowserShow!(selected));
        }
      }
      if (revision === current) { reportError(null); setOverlayReady(true); }
    } catch (cause) {
      if (revision !== current) return;
      if (shouldHide && selected && api.terminalBrowserHide) {
        try { await bounded(api.terminalBrowserHide(selected)); }
        catch { /* Surface the failure below; never leave a dialog waiting forever. */ }
      }
      if (revision !== current) return;
      reportError(cause instanceof Error ? cause.message : "浏览器显示切换失败");
      setOverlayReady(true);
    }
  })();
  return pending;
}
subscribeOverlays(() => { void sync(); });

export function setBrowserPresentationHost(nextActive: boolean, nextTabId: string | null): Promise<void> {
  active = nextActive;
  tabId = nextTabId;
  setOverlayViewport(active ? bounds : null);
  return sync();
}
export function setBrowserPresentationBounds(next: TerminalBrowserBounds): void {
  bounds = next;
  setOverlayViewport(active ? bounds : null);
}
export function useBrowserPresentation() {
  return {
    suppressed: useSyncExternalStore(subscribeOverlays, getOverlaySuppressed),
    error: useSyncExternalStore(subscribe, getError),
    retry: () => { void sync(true); },
  };
}
