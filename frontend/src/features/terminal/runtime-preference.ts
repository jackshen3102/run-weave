import type { TerminalRuntimePreference } from "@runweave/shared/terminal/session";
import type { ClientMode } from "../client-mode";

export function resolveNewTerminalRuntimePreference(
  clientMode: ClientMode,
): TerminalRuntimePreference {
  return clientMode === "mobile" ? "pty" : "auto";
}
