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
