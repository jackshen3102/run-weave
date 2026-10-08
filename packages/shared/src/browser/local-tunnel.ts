/** Native hosts only: one authenticated WebSocket carries one local TCP stream. */
export const LOCAL_BROWSER_PROTOCOL = 1;
export const LOCAL_BROWSER_MAX_FRAME = 64 * 1024;
export const LOCAL_BROWSER_MAX_BUFFER = 1024 * 1024;
export const LOCAL_BROWSER_MAX_CONNECTIONS = 32;
export interface LocalBrowserCapabilities {
  protocolVersion: 1;
  maxConnections: number;
  maxFrameBytes: number;
}
export interface LocalBrowserOpen {
  type: "open";
  version: 1;
  terminalSessionId: string;
  browserSessionId: string;
  host: string;
  port: number;
  secure: boolean;
}
export type LocalBrowserError =
  | "unsupported_version"
  | "invalid_target"
  | "unauthorized"
  | "source_unavailable"
  | "target_unavailable"
  | "connect_timeout"
  | "connection_limit"
  | "protocol_error"
  | "buffer_limit";
export type LocalBrowserControl =
  | { type: "ready" }
  | { type: "eof" }
  | { type: "error"; code: LocalBrowserError };

/** IPC only. Never persist or expose accessToken to a browser page. */
export interface DesktopLocalBrowserSource {
  connectionId: string;
  connectionName: string;
  scope: string;
  apiBase: string;
  accessToken: string;
  terminalSessionId: string;
}

export interface DesktopLocalBrowserInfo {
  connectionId: string;
  connectionName: string;
  originalUrl: string;
}

export function parseLocalBrowserTarget(raw: string): { url: string; host: string; port: number; secure: boolean } | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    // WHATWG URL already canonicalizes IPv4 shorthand and numeric literals.
    if (host === "::ffff:0:0") host = "0.0.0.0";
    const mapped = host.match(/^::ffff:7f([0-9a-f]{2}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const tail = Number.parseInt(mapped[2]!, 16);
      host = `127.${Number.parseInt(mapped[1]!, 16)}.${tail >> 8}.${tail & 255}`;
    }
    if (!(host === "localhost" || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost$/.test(host) ||
      /^127\.\d+\.\d+\.\d+$/.test(host) || ["0.0.0.0", "::", "::1"].includes(host))) return null;
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (port < 1 || port > 65535) return null;
    return { url: url.toString(), host, port, secure: url.protocol === "https:" };
  } catch { return null; }
}
