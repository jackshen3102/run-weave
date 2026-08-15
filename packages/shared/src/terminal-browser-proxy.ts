export const TERMINAL_BROWSER_PROXY_HOST = "127.0.0.1";
export const TERMINAL_BROWSER_PROXY_DEFAULT_PORT = 8899;
export const TERMINAL_BROWSER_PROXY_MIN_PORT = 1;
export const TERMINAL_BROWSER_PROXY_MAX_PORT = 65535;

export interface TerminalBrowserProxyState {
  enabled: boolean;
  port: number;
  proxyRules: string;
  proxyBypassRules: string;
}

export function isValidTerminalBrowserProxyPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TERMINAL_BROWSER_PROXY_MIN_PORT &&
    value <= TERMINAL_BROWSER_PROXY_MAX_PORT
  );
}

export function buildTerminalBrowserProxyRules(port: number): string {
  return `http=${TERMINAL_BROWSER_PROXY_HOST}:${port};https=${TERMINAL_BROWSER_PROXY_HOST}:${port}`;
}
