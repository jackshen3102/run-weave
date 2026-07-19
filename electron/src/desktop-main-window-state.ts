import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_DESKTOP_WINDOW_WIDTH = 1280;
export const DEFAULT_DESKTOP_WINDOW_HEIGHT = 860;
export const MIN_DESKTOP_WINDOW_WIDTH = 800;
export const MIN_DESKTOP_WINDOW_HEIGHT = 600;

export type DesktopWindowMode = "normal" | "maximized" | "fullscreen";

export interface DesktopMainWindowState {
  bounds: Rectangle;
  displayId: number;
  mode: DesktopWindowMode;
}

interface PersistedDesktopMainWindowState extends DesktopMainWindowState {
  version: 1;
}

const STORE_FILE = "desktop-main-window-state.json";
const SAVE_DELAY_MS = 200;

function storePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseState(value: unknown): PersistedDesktopMainWindowState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<PersistedDesktopMainWindowState>;
  const bounds = candidate.bounds;
  if (
    candidate.version !== 1 ||
    !["normal", "maximized", "fullscreen"].includes(candidate.mode ?? "") ||
    !Number.isInteger(candidate.displayId) ||
    !bounds ||
    !isFiniteNumber(bounds.x) ||
    !isFiniteNumber(bounds.y) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }
  return candidate as PersistedDesktopMainWindowState;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function fitBoundsToWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
): Rectangle {
  const minimumWidth = Math.min(MIN_DESKTOP_WINDOW_WIDTH, workArea.width);
  const minimumHeight = Math.min(MIN_DESKTOP_WINDOW_HEIGHT, workArea.height);
  const width = clamp(Math.round(bounds.width), minimumWidth, workArea.width);
  const height = clamp(
    Math.round(bounds.height),
    minimumHeight,
    workArea.height,
  );
  return {
    x: clamp(
      Math.round(bounds.x),
      workArea.x,
      workArea.x + workArea.width - width,
    ),
    y: clamp(
      Math.round(bounds.y),
      workArea.y,
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}

export function readDesktopMainWindowState(): DesktopMainWindowState | null {
  let persisted: PersistedDesktopMainWindowState | null = null;
  try {
    persisted = parseState(JSON.parse(readFileSync(storePath(), "utf8")));
  } catch {
    return null;
  }
  if (!persisted) {
    return null;
  }

  const display =
    screen
      .getAllDisplays()
      .find((candidate) => candidate.id === persisted.displayId) ??
    screen.getPrimaryDisplay();
  return {
    bounds: fitBoundsToWorkArea(persisted.bounds, display.workArea),
    displayId: display.id,
    mode: persisted.mode,
  };
}

function writeDesktopMainWindowState(
  win: BrowserWindow,
  mode: DesktopWindowMode,
): void {
  if (win.isDestroyed()) {
    return;
  }
  const bounds = win.getNormalBounds();
  const display = screen.getDisplayMatching(win.getBounds());
  const state: PersistedDesktopMainWindowState = {
    version: 1,
    bounds,
    displayId: display.id,
    mode,
  };
  const target = storePath();
  const temporary = `${target}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(temporary, JSON.stringify(state), "utf8");
    renameSync(temporary, target);
  } catch {
    return;
  }
}

export function trackDesktopMainWindowState(
  win: BrowserWindow,
  initialMode: DesktopWindowMode,
): void {
  let mode = initialMode;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveNow = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeDesktopMainWindowState(win, mode);
  };
  const scheduleSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  };

  win.on("move", scheduleSave);
  win.on("resize", scheduleSave);
  win.on("maximize", () => {
    if (!win.isFullScreen()) {
      mode = "maximized";
      scheduleSave();
    }
  });
  win.on("unmaximize", () => {
    if (!win.isFullScreen()) {
      mode = "normal";
      scheduleSave();
    }
  });
  win.on("enter-full-screen", () => {
    mode = "fullscreen";
    scheduleSave();
  });
  win.on("leave-full-screen", () => {
    mode = win.isMaximized() ? "maximized" : "normal";
    scheduleSave();
  });
  win.once("ready-to-show", scheduleSave);
  win.on("close", saveNow);
  win.once("closed", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  });
}
