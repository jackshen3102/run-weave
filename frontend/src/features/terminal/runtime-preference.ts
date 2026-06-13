import type { TerminalRuntimePreference } from "@runweave/shared";
import type { ClientMode } from "../client-mode";

export function resolveNewTerminalRuntimePreference(
  clientMode: ClientMode,
): TerminalRuntimePreference {
  return clientMode === "mobile" ? "pty" : "auto";
}
