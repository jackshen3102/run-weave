import { BrowserWindow, screen, type Point, type Rectangle } from "electron";
import { getIsQuitting } from "./app-state.js";
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

function showCompanionWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || getIsQuitting()) return;
  // showInactive keeps the companion off the key-window path. Visibility across
  // Spaces and other apps' fullscreen is handled by alwaysOnTop("screen-saver")
  // plus setVisibleOnAllWorkspaces; do NOT call moveTop here. moveTop on a panel
  // while the main window is fullscreen makes macOS re-evaluate app activation,
  // which fires did-become-active/did-resign-active in a feedback loop that
  // repeatedly pulls the fullscreen main window forward (see incident diag).
  win.showInactive();
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
    type: process.platform === "darwin" ? "panel" : undefined,
    // macOS: a non-activating panel receives clicks and drags but never makes
    // Runweave the active app, so clicking the companion cannot pull the main
    // window forward or switch Spaces when another window is fullscreen. The
    // companion has no text input, so it never needs keyboard focus.
    focusable: process.platform === "darwin" ? false : undefined,
    resizable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(
    true,
    process.platform === "darwin" ? "screen-saver" : "floating",
  );
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  trackDesktopCompanionWindowState(win);
  setupSessionIntercept(win);
  win.once("ready-to-show", () => {
    clampCompanionWindow(win);
    showCompanionWindow(win);
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
