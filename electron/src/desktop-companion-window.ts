import { BrowserWindow, screen, type Point, type Rectangle } from "electron";
import { CUSTOM_PROTOCOL, DEV_SERVER_URL, PRELOAD_PATH, isDev } from "./desktop-config.js";
import { setupSessionIntercept } from "./desktop-window.js";
import {
  readDesktopCompanionWindowState,
  trackDesktopCompanionWindowState,
  type DesktopCompanionWindowState,
} from "./desktop-companion-window-state.js";

const WIDTH = 410;
const HEIGHT = 480;
const INSET = 16;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function fitBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function initialBounds(
  size: { width: number; height: number },
  state: DesktopCompanionWindowState | null,
): Rectangle {
  const display = state
    ? screen.getAllDisplays().find((candidate) => candidate.id === state.displayId) ??
      screen.getPrimaryDisplay()
    : screen.getPrimaryDisplay();
  const right = state?.right ?? display.workArea.x + display.workArea.width - INSET;
  const bottom = state?.bottom ?? display.workArea.y + display.workArea.height - INSET;
  return fitBoundsToWorkArea(
    { x: right - size.width, y: bottom - size.height, ...size },
    display.workArea,
  );
}

function clampCompanionWindow(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  win.setBounds(fitBoundsToWorkArea(bounds, display.workArea), false);
}

export function moveCompanionWindow(
  win: BrowserWindow,
  requested: Point,
  pointer: Point,
): void {
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint(pointer);
  const fitted = fitBoundsToWorkArea(
    { ...bounds, x: requested.x, y: requested.y },
    display.workArea,
  );
  win.setPosition(fitted.x, fitted.y, false);
}

export function resizeCompanionWindow(
  win: BrowserWindow,
  requested: { width: number; height: number },
): void {
  const current = win.getBounds();
  const workArea = screen.getDisplayMatching(current).workArea;
  const width = Math.min(Math.max(Math.ceil(requested.width), 86), Math.min(WIDTH, workArea.width));
  const height = Math.min(Math.max(Math.ceil(requested.height), 86), Math.min(HEIGHT, workArea.height));
  const next = fitBoundsToWorkArea(
    {
      x: current.x + current.width - width,
      y: current.y + current.height - height,
      width,
      height,
    },
    workArea,
  );
  win.setBounds(next, false);
}

export function createCompanionWindow(): BrowserWindow {
  const restoredState = readDesktopCompanionWindowState();
  const bounds = initialBounds({ width: WIDTH, height: HEIGHT }, restoredState);
  const win = new BrowserWindow({
    ...bounds,
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
  trackDesktopCompanionWindowState(win);
  setupSessionIntercept(win);
  win.once("ready-to-show", () => {
    clampCompanionWindow(win);
    win.showInactive();
  });
  if (isDev) {
    void win.loadURL(`${DEV_SERVER_URL}/desktop-companion`);
  } else {
    void win.loadURL(`${CUSTOM_PROTOCOL}://app/desktop-companion`);
  }
  const reposition = (): void => clampCompanionWindow(win);
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
