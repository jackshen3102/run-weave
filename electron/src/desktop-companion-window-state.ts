import { app, screen, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DesktopCompanionWindowState {
  right: number;
  bottom: number;
  displayId: number;
}

interface PersistedDesktopCompanionWindowState extends DesktopCompanionWindowState {
  version: 1;
}

const STORE_FILE = "desktop-companion-window-state.json";
const SAVE_DELAY_MS = 200;

function storePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readDesktopCompanionWindowState(): DesktopCompanionWindowState | null {
  try {
    const parsed = JSON.parse(
      readFileSync(storePath(), "utf8"),
    ) as Partial<PersistedDesktopCompanionWindowState>;
    if (
      parsed.version !== 1 ||
      !isFiniteNumber(parsed.right) ||
      !isFiniteNumber(parsed.bottom) ||
      typeof parsed.displayId !== "number" ||
      !Number.isInteger(parsed.displayId)
    ) {
      return null;
    }
    return {
      right: parsed.right,
      bottom: parsed.bottom,
      displayId: parsed.displayId,
    };
  } catch {
    return null;
  }
}

export function writeDesktopCompanionWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const state: PersistedDesktopCompanionWindowState = {
    version: 1,
    right: bounds.x + bounds.width,
    bottom: bounds.y + bounds.height,
    displayId: display.id,
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

export function trackDesktopCompanionWindowState(win: BrowserWindow): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveNow = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeDesktopCompanionWindowState(win);
  };
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  };

  win.on("move", scheduleSave);
  win.once("ready-to-show", scheduleSave);
  win.on("close", saveNow);
  win.once("closed", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  });
}
