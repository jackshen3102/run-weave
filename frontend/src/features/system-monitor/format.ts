export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatMemory(mb: number): string {
  if (!Number.isFinite(mb)) {
    return "-";
  }
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 1 : 2)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

export function formatTime(timestamp: number | null): string {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

export function formatBatteryRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "rate unknown";
  }
  return `${value > 0 ? "+" : ""}${Math.round(value)} mA`;
}

export function formatBatteryTime(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) {
    return "no estimate";
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}
