import { recordSupportLog } from "../features/support-logs";

function toEventName(message: string): string {
  return `legacy.${message
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")}`;
}

// Compatibility shim for older call sites; new App code should use support logs.
export function aiDiagnosticLog(
  message: string,
  details?: Record<string, unknown>,
): void {
  recordSupportLog(toEventName(message), details);
}
