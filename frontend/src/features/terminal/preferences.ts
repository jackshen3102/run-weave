export type TerminalRendererPreference = "auto" | "webgl" | "canvas" | "dom";
export type TerminalBellMode = "off" | "sound";
export type TerminalFontFamilyPreference =
  | '"Fira Code", "SFMono-Regular", ui-monospace, monospace'
  | '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace'
  | '"SFMono-Regular", ui-monospace, monospace';

export interface TerminalPreferences {
  fontFamily: TerminalFontFamilyPreference;
  fontSize: number;
  cursorBlink: boolean;
  screenReaderMode: boolean;
  copyOnSelect: boolean;
  renderer: TerminalRendererPreference;
  bellMode: TerminalBellMode;
}

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: '"Fira Code", "SFMono-Regular", ui-monospace, monospace',
  fontSize: 13,
  cursorBlink: true,
  screenReaderMode: false,
  copyOnSelect: false,
  renderer: "dom",
  bellMode: "off",
};

const TERMINAL_PANEL_SPLIT_ENABLED_STORAGE_KEY =
  "runweave:terminal:panel-split-enabled:v1";

export function readTerminalPanelSplitEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return (
      window.localStorage.getItem(TERMINAL_PANEL_SPLIT_ENABLED_STORAGE_KEY) ===
      "true"
    );
  } catch {
    return false;
  }
}

export function writeTerminalPanelSplitEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      TERMINAL_PANEL_SPLIT_ENABLED_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // Ignore storage failures; the in-memory toggle still applies.
  }
}
