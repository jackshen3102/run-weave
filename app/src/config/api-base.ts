const REMOTE_API_BASE = "https://runweave.jackshen310.cn";

function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function readConfiguredApiBase(key: string): string | null {
  const value = import.meta.env[key];
  return typeof value === "string" ? normalizeApiBase(value) : null;
}

function isLocalHttpOrigin(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const { protocol, hostname } = window.location;
  return (
    protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  );
}

export function resolveDefaultApiBase(): string {
  const explicitApiBase = readConfiguredApiBase("VITE_RUNWEAVE_API_BASE");
  if (explicitApiBase !== null) {
    return explicitApiBase;
  }

  if (isLocalHttpOrigin()) {
    return "";
  }

  return REMOTE_API_BASE;
}
