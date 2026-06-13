import type { AppDeviceConnectionStatus } from "../hooks/use-app-device-connection";

interface AppDeviceStatusBadgeProps {
  status: AppDeviceConnectionStatus;
  message: string;
  lastSeenAt: number | null;
}

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) {
    return null;
  }
  const elapsedMs = Math.max(0, Date.now() - lastSeenAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60000);
  if (elapsedMinutes < 1) {
    return "Last seen now";
  }
  if (elapsedMinutes < 60) {
    return `Last seen ${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `Last seen ${elapsedHours}h ago`;
}

export function AppDeviceStatusBadge({
  status,
  message,
  lastSeenAt,
}: AppDeviceStatusBadgeProps) {
  const label =
    status === "online" ? "Online" : status === "offline" ? "Offline" : "Checking";
  const detail = status === "offline" ? formatLastSeen(lastSeenAt) : null;

  return (
    <span
      aria-label={`${label}${detail ? `, ${detail}` : ""}`}
      className={`app-device-status app-device-status--${status}`}
      title={message}
    >
      <span className="app-device-status__dot" aria-hidden="true" />
      <span className="app-device-status__label">{label}</span>
      {detail ? <span className="app-device-status__detail">{detail}</span> : null}
    </span>
  );
}
