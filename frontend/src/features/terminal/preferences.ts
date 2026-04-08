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
  renderer: "auto",
  bellMode: "off",
};

const VALID_RENDERERS = new Set<TerminalRendererPreference>([
  "auto",
  "webgl",
  "canvas",
  "dom",
]);
const VALID_BELL_MODES = new Set<TerminalBellMode>(["off", "sound"]);
const VALID_FONT_FAMILIES = new Set<TerminalFontFamilyPreference>([
  '"Fira Code", "SFMono-Regular", ui-monospace, monospace',
  '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
  '"SFMono-Regular", ui-monospace, monospace',
]);

function buildStorageKey(apiBase: string): string {
  return `viewer.terminal.preferences.${apiBase}`;
}

function sanitizePreferences(
  raw: Partial<TerminalPreferences>,
): TerminalPreferences {
  return {
    fontFamily: VALID_FONT_FAMILIES.has(raw.fontFamily as TerminalFontFamilyPreference)
      ? (raw.fontFamily as TerminalFontFamilyPreference)
      : DEFAULT_TERMINAL_PREFERENCES.fontFamily,
    fontSize:
      typeof raw.fontSize === "number" &&
      Number.isFinite(raw.fontSize) &&
      raw.fontSize >= 11 &&
      raw.fontSize <= 24
        ? raw.fontSize
        : DEFAULT_TERMINAL_PREFERENCES.fontSize,
    cursorBlink:
      typeof raw.cursorBlink === "boolean"
        ? raw.cursorBlink
        : DEFAULT_TERMINAL_PREFERENCES.cursorBlink,
    screenReaderMode:
      typeof raw.screenReaderMode === "boolean"
        ? raw.screenReaderMode
        : DEFAULT_TERMINAL_PREFERENCES.screenReaderMode,
    copyOnSelect:
      typeof raw.copyOnSelect === "boolean"
        ? raw.copyOnSelect
        : DEFAULT_TERMINAL_PREFERENCES.copyOnSelect,
    renderer: VALID_RENDERERS.has(raw.renderer as TerminalRendererPreference)
      ? (raw.renderer as TerminalRendererPreference)
      : DEFAULT_TERMINAL_PREFERENCES.renderer,
    bellMode: VALID_BELL_MODES.has(raw.bellMode as TerminalBellMode)
      ? (raw.bellMode as TerminalBellMode)
      : DEFAULT_TERMINAL_PREFERENCES.bellMode,
  };
}

export function loadTerminalPreferences(apiBase: string): TerminalPreferences {
  const raw = localStorage.getItem(buildStorageKey(apiBase));
  if (!raw) {
    return DEFAULT_TERMINAL_PREFERENCES;
  }

  try {
    return sanitizePreferences(
      JSON.parse(raw) as Partial<TerminalPreferences>,
    );
  } catch {
    return DEFAULT_TERMINAL_PREFERENCES;
  }
}

export function saveTerminalPreferences(
  apiBase: string,
  updates: Partial<TerminalPreferences>,
): TerminalPreferences {
  const nextPreferences = sanitizePreferences({
    ...loadTerminalPreferences(apiBase),
    ...updates,
  });
  localStorage.setItem(
    buildStorageKey(apiBase),
    JSON.stringify(nextPreferences),
  );
  return nextPreferences;
}
