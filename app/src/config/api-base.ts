function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function readConfiguredApiBase(key: string): string | null {
  const value = import.meta.env[key];
  return typeof value === "string" ? normalizeApiBase(value) : null;
}

export function resolveDefaultApiBase(): string {
  return readConfiguredApiBase("VITE_RUNWEAVE_API_BASE") ?? "";
}
