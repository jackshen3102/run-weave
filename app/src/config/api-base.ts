const REMOTE_API_BASE = "https://runweave.jackshen310.cn";
const DEFAULT_LOCAL_API_BASE = "http://localhost:5001";

function readEnvValue(key: string): string | null {
  const value = import.meta.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLocalBrowserOrigin(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const { protocol, hostname } = window.location;
  return (
    protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  );
}

export function isLocalApiBaseEditable(): boolean {
  return import.meta.env.DEV || isLocalBrowserOrigin();
}

export function resolveDefaultApiBase(): string {
  const explicitApiBase = readEnvValue("VITE_RUNWEAVE_API_BASE");
  if (explicitApiBase) {
    return explicitApiBase.replace(/\/+$/, "");
  }

  if (isLocalApiBaseEditable()) {
    const backendPort = readEnvValue("VITE_RUNWEAVE_BACKEND_PORT");
    return backendPort
      ? `http://localhost:${backendPort}`
      : DEFAULT_LOCAL_API_BASE;
  }

  return REMOTE_API_BASE;
}
