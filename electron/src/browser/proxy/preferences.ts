import { ConfigurationDomain } from "@runweave/config-node";
import { requireDesktopMigration } from "../../desktop/configuration-migration.js";
import { TERMINAL_BROWSER_PROXY_DEFAULT_PORT, isValidTerminalBrowserProxyPort } from "@runweave/shared/terminal-browser-proxy";
export interface TerminalBrowserProxyPreferences { enabled: boolean; port: number }
const store = new ConfigurationDomain<TerminalBrowserProxyPreferences>("desktop.browser.proxy");
export function readTerminalBrowserProxyPreferences(): TerminalBrowserProxyPreferences {
  requireDesktopMigration("desktop.browser.proxy", "terminal-browser-proxy.json");
  return store.read() ?? { enabled: false, port: TERMINAL_BROWSER_PROXY_DEFAULT_PORT };
}
export function writeTerminalBrowserProxyPreferences(preferences: TerminalBrowserProxyPreferences): void {
  if (!isValidTerminalBrowserProxyPort(preferences.port) || typeof preferences.enabled !== "boolean") throw new Error("CONFIG_PROXY_INVALID");
  store.write(preferences);
}
