import { BrowserWindow, screen } from "electron";
import { CUSTOM_PROTOCOL, DEV_SERVER_URL, PRELOAD_PATH, isDev } from "./desktop-config.js";
import { setupSessionIntercept } from "./desktop-window.js";

const WIDTH = 410;
const HEIGHT = 480;
const INSET = 16;

export function positionCompanionWindow(win: BrowserWindow): void {
  const workArea = screen.getPrimaryDisplay().workArea;
  const size = win.getSize();
  const width = size[0] ?? WIDTH;
  const height = size[1] ?? HEIGHT;
  win.setPosition(
    workArea.x + Math.max(0, workArea.width - width - INSET),
    workArea.y + Math.max(0, workArea.height - height - INSET),
    false,
  );
}

export function resizeCompanionWindow(
  win: BrowserWindow,
  requested: { width: number; height: number },
): void {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(Math.ceil(requested.width), 86), Math.min(WIDTH, workArea.width));
  const height = Math.min(Math.max(Math.ceil(requested.height), 86), Math.min(HEIGHT, workArea.height));
  win.setSize(width, height, false);
  positionCompanionWindow(win);
}

export function createCompanionWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionCompanionWindow(win);
  setupSessionIntercept(win);
  win.once("ready-to-show", () => {
    positionCompanionWindow(win);
    win.showInactive();
  });
  if (isDev) {
    void win.loadURL(`${DEV_SERVER_URL}/desktop-companion`);
  } else {
    void win.loadURL(`${CUSTOM_PROTOCOL}://app/desktop-companion`);
  }
  const reposition = (): void => positionCompanionWindow(win);
  screen.on("display-added", reposition);
  screen.on("display-removed", reposition);
  screen.on("display-metrics-changed", reposition);
  win.once("closed", () => {
    screen.off("display-added", reposition);
    screen.off("display-removed", reposition);
    screen.off("display-metrics-changed", reposition);
  });
  return win;
}
