import { BrowserWindow, ipcMain } from "electron";
import type { TerminalBrowserPresentationState } from "@runweave/shared/desktop-bridge";
import { terminalBrowserRuntime, type TerminalBrowserEntry } from "../runtime.js";

interface WindowPresentation extends TerminalBrowserPresentationState {
  managed: boolean;
  target: TerminalBrowserEntry | null;
}
const windows = new Map<number, WindowPresentation>();
const captureOwners = new WeakSet<TerminalBrowserEntry>();

function stateFor(win: BrowserWindow): WindowPresentation {
  const existing = windows.get(win.id);
  if (existing) return existing;
  const state: WindowPresentation = {
    revision: -1, active: true, suppressed: false, managed: false, target: null,
  };
  windows.set(win.id, state);
  const reset = () => {
    Object.assign(state, { revision: -1, active: false, suppressed: false, managed: true, target: null });
    applyTerminalBrowserPresentation(win);
  };
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) reset();
  });
  win.webContents.on("render-process-gone", reset);
  win.once("closed", () => windows.delete(win.id));
  return state;
}

export function applyTerminalBrowserPresentation(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const state = stateFor(win);
  for (const entry of terminalBrowserRuntime.entries.values()) {
    if (entry.windowId !== win.id || captureOwners.has(entry)) continue;
    const bounds = entry.viewportBounds;
    const visible = state.target === entry && state.active && !state.suppressed &&
      entry.attached && (!state.managed || Boolean(bounds && bounds.width > 0 && bounds.height > 0));
    if (entry.visible !== visible) {
      entry.viewportView.setVisible(visible);
      entry.visible = visible;
    }
  }
}

export function setTerminalBrowserPresentation(win: BrowserWindow, value: unknown): void {
  const next = value as TerminalBrowserPresentationState | null;
  if (!next || !Number.isSafeInteger(next.revision) || next.revision < 0 ||
      typeof next.active !== "boolean" || typeof next.suppressed !== "boolean") {
    throw new Error("Invalid browser presentation state");
  }
  const state = stateFor(win);
  if (next.revision <= state.revision) return;
  Object.assign(state, { revision: next.revision, active: next.active, suppressed: next.suppressed, managed: true });
  applyTerminalBrowserPresentation(win);
}

export function selectTerminalBrowserPresentation(win: BrowserWindow, entry: TerminalBrowserEntry): void {
  stateFor(win).target = entry;
  applyTerminalBrowserPresentation(win);
}

export function hideTerminalBrowserPresentation(win: BrowserWindow, entry?: TerminalBrowserEntry): void {
  const state = stateFor(win);
  if (!entry || state.target === entry) state.target = null;
  applyTerminalBrowserPresentation(win);
}

/** A capture host owns its own visibility; only restoration belongs to the main window. */
export function borrowTerminalBrowserPresentation(win: BrowserWindow, entry: TerminalBrowserEntry): (beforeApply?: () => void) => void {
  captureOwners.add(entry);
  return (beforeApply) => {
    captureOwners.delete(entry);
    if (win.isDestroyed() || entry.view.webContents.isDestroyed()) return;
    const state = stateFor(win);
    // Selection may have changed while the capture host owned the parent.
    if (state.target === entry && state.active && !entry.attached) {
      win.contentView.addChildView(entry.viewportView);
      entry.attached = true;
    }
    beforeApply?.();
    applyTerminalBrowserPresentation(win);
  };
}

export function isTerminalBrowserPresentationBorrowed(entry: TerminalBrowserEntry): boolean {
  return captureOwners.has(entry);
}

export function registerTerminalBrowserPresentationHandler(): void {
  ipcMain.handle("terminal-browser:set-presentation", (event, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Browser presentation requires the owning main frame");
    }
    setTerminalBrowserPresentation(win, value);
  });
}
