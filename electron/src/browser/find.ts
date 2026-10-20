import { BrowserWindow, ipcMain } from "electron";
import type { TerminalBrowserFindCommand, TerminalBrowserFindState } from "@runweave/shared/desktop-bridge";
import type { TerminalBrowserEntry } from "./runtime.js";
import { getExistingTerminalBrowserEntry } from "./view/helpers.js";

interface FindSession {
  state: TerminalBrowserFindState;
  requestId: number | null;
}

const sessions = new WeakMap<TerminalBrowserEntry, FindSession>();

export function attachTerminalBrowserFind(win: BrowserWindow, tabId: string, entry: TerminalBrowserEntry): void {
  const session: FindSession = {
    state: { tabId, open: false, query: "", matches: 0, activeMatchOrdinal: 0, focusRevision: 0, revision: 0 },
    requestId: null,
  };
  sessions.set(entry, session);
  const contents = entry.view.webContents;
  contents.on("found-in-page", (_event, result) => {
    if (session.requestId !== result.requestId || !session.state.open) return;
    session.state.matches = result.matches;
    session.state.activeMatchOrdinal = result.activeMatchOrdinal;
    publish(win, session);
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !entry.visible) return;
    if ((input.control || input.meta) && !input.alt && !input.shift && input.key.toLowerCase() === "f") {
      event.preventDefault();
      win.webContents.focus();
      runCommand(win, entry, { action: "open" });
    } else if (input.key === "Escape" && session.state.open) {
      event.preventDefault();
      runCommand(win, entry, { action: "close" });
    }
  });
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (!mainFrame || inPlace) return;
    reset(entry, session);
    session.state.open = false;
    publish(win, session);
  });
}

function publish(win: BrowserWindow, session: FindSession): void {
  session.state.revision += 1;
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("terminal-browser:find-changed", { ...session.state });
  }
}

function reset(entry: TerminalBrowserEntry, session: FindSession): void {
  session.requestId = null;
  entry.view.webContents.stopFindInPage("clearSelection");
  session.state.matches = 0;
  session.state.activeMatchOrdinal = 0;
}

function runCommand(win: BrowserWindow, entry: TerminalBrowserEntry, command: TerminalBrowserFindCommand): void {
  const session = sessions.get(entry)!;
  const state = session.state;
  switch (command.action) {
    case "open":
      state.open = true;
      state.focusRevision += 1;
      // Reopening after Escape starts a fresh Chromium find session.
      if (state.query && session.requestId === null) {
        session.requestId = entry.view.webContents.findInPage(state.query);
      }
      break;
    case "close":
      reset(entry, session);
      state.open = false;
      if (entry.visible) entry.view.webContents.focus();
      break;
    case "search":
      reset(entry, session);
      state.query = command.query;
      state.open = true;
      if (state.query) session.requestId = entry.view.webContents.findInPage(state.query);
      break;
    case "next":
    case "previous":
      if (!state.open || !state.query) return;
      session.requestId = entry.view.webContents.findInPage(state.query, {
        forward: command.action === "next",
        findNext: true,
      });
      break;
  }
  publish(win, session);
}

export function registerTerminalBrowserFindHandlers(): void {
  ipcMain.handle("terminal-browser:find-state", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.senderFrame !== event.sender.mainFrame || typeof tabId !== "string") {
      throw new Error("Invalid browser find request");
    }
    const entry = getExistingTerminalBrowserEntry(win, tabId, "find in");
    return { ...sessions.get(entry)!.state };
  });
  ipcMain.handle("terminal-browser:find", (event, tabId: string, command: TerminalBrowserFindCommand) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.senderFrame !== event.sender.mainFrame || typeof tabId !== "string" || !command ||
      !["open", "close", "search", "next", "previous"].includes(command.action) ||
      (command.action === "search" && typeof command.query !== "string")) {
      throw new Error("Invalid browser find request");
    }
    runCommand(win, getExistingTerminalBrowserEntry(win, tabId, "find in"), command);
  });
}
