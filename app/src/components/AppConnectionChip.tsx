import type { AppConnectionConfig } from "../features/connections/types";

function formatConnectionHost(connection: AppConnectionConfig | null): string {
  if (!connection) {
    return "No backend";
  }
  if (!connection.url) {
    return typeof window !== "undefined" ? window.location.host : "App origin";
  }
  try {
    return new URL(connection.url).host;
  } catch {
    return connection.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

export function getAppConnectionHostLabel(
  connection: AppConnectionConfig | null,
): string {
  return formatConnectionHost(connection);
}

export function AppConnectionChip({
  connection,
  disabled,
  onClick,
  status,
}: {
  connection: AppConnectionConfig | null;
  disabled?: boolean;
  onClick: () => void;
  status?: "checking" | "online" | "offline";
}) {
  const resolvedStatus =
    status ??
    (connection?.available === true
      ? "online"
      : connection?.available === false
        ? "offline"
        : "checking");

  return (
    <button
      className="app-connection-chip"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span
        aria-hidden="true"
        className={[
          "app-connection-chip__dot",
          resolvedStatus === "offline" ? "is-offline" : "",
          resolvedStatus === "online" ? "is-online" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      <span className="app-connection-chip__text">
        <strong>{connection?.name ?? "Add backend"}</strong>
        <span>{formatConnectionHost(connection)}</span>
      </span>
    </button>
  );
}
