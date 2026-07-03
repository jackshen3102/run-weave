import { app } from "electron";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeTerminalBrowserPersistedState,
  type TerminalBrowserPersistedState,
} from "./terminal-browser-tabs-state.js";

const TERMINAL_BROWSER_TABS_STORE_FILE = "terminal-browser-tabs.json";

function getTerminalBrowserTabsStorePath(): string {
  return path.join(app.getPath("userData"), TERMINAL_BROWSER_TABS_STORE_FILE);
}

export async function readTerminalBrowserPersistedState(): Promise<TerminalBrowserPersistedState> {
  const storePath = getTerminalBrowserTabsStorePath();
  try {
    const raw = await readFile(storePath, "utf8");
    return normalizeTerminalBrowserPersistedState(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { version: 1, activeTabId: null, tabs: [] };
    }
    console.warn("[electron] failed to read terminal browser tabs state", {
      path: storePath,
      error: error instanceof Error ? error.message : String(error),
    });
    await backupUnreadableTerminalBrowserTabsStore(storePath);
    return { version: 1, activeTabId: null, tabs: [] };
  }
}

async function backupUnreadableTerminalBrowserTabsStore(
  storePath: string,
): Promise<void> {
  const backupPath = `${storePath}.bad-${Date.now()}`;
  try {
    await copyFile(storePath, backupPath);
    console.warn("[electron] backed up unreadable terminal browser tabs state", {
      backupPath,
    });
  } catch (error) {
    console.warn("[electron] failed to back up terminal browser tabs state", {
      path: storePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function writeTerminalBrowserPersistedState(
  state: TerminalBrowserPersistedState,
): Promise<void> {
  const storePath = getTerminalBrowserTabsStorePath();
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
