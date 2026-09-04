import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  TERMINAL_BROWSER_PROXY_DEFAULT_PORT,
  isValidTerminalBrowserProxyPort,
} from "@runweave/shared/terminal-browser-proxy";

export interface TerminalBrowserProxyPreferences {
  enabled: boolean;
  port: number;
}

interface PersistedTerminalBrowserProxyPreferences
  extends TerminalBrowserProxyPreferences {
  version: 1;
}

const STORE_FILE = "terminal-browser-proxy.json";

function storePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

function defaultPreferences(): TerminalBrowserProxyPreferences {
  return { enabled: false, port: TERMINAL_BROWSER_PROXY_DEFAULT_PORT };
}

export function readTerminalBrowserProxyPreferences(): TerminalBrowserProxyPreferences {
  try {
    const parsed = JSON.parse(
      readFileSync(storePath(), "utf8"),
    ) as Partial<PersistedTerminalBrowserProxyPreferences>;
    if (
      parsed.version !== 1 ||
      typeof parsed.enabled !== "boolean" ||
      !isValidTerminalBrowserProxyPort(parsed.port)
    ) {
      return defaultPreferences();
    }
    return { enabled: parsed.enabled, port: parsed.port };
  } catch {
    return defaultPreferences();
  }
}

export function writeTerminalBrowserProxyPreferences(
  preferences: TerminalBrowserProxyPreferences,
): void {
  const state: PersistedTerminalBrowserProxyPreferences = {
    version: 1,
    enabled: preferences.enabled,
    port: preferences.port,
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
