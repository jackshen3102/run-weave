export type TerminalBrowserDevicePresetId =
  | "desktop"
  | "iphone-se"
  | "iphone-14"
  | "pixel-7";

export interface TerminalBrowserDeviceViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface TerminalBrowserDevicePreset {
  id: TerminalBrowserDevicePresetId;
  label: string;
  mobile: boolean;
  viewport: TerminalBrowserDeviceViewport | null;
  userAgent: string | null;
}

export interface TerminalBrowserDeviceState {
  presetId: TerminalBrowserDevicePresetId;
  label: string;
  mobile: boolean;
  viewport: TerminalBrowserDeviceViewport | null;
}

const MOBILE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const MOBILE_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

export const TERMINAL_BROWSER_DEVICE_PRESETS: TerminalBrowserDevicePreset[] = [
  {
    id: "desktop",
    label: "Desktop",
    mobile: false,
    viewport: null,
    userAgent: null,
  },
  {
    id: "iphone-se",
    label: "iPhone SE",
    mobile: true,
    viewport: { width: 375, height: 667, deviceScaleFactor: 2 },
    userAgent: MOBILE_SAFARI_UA,
  },
  {
    id: "iphone-14",
    label: "iPhone 14",
    mobile: true,
    viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    userAgent: MOBILE_SAFARI_UA,
  },
  {
    id: "pixel-7",
    label: "Pixel 7",
    mobile: true,
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.625 },
    userAgent: MOBILE_CHROME_UA,
  },
];

export const TERMINAL_BROWSER_DESKTOP_DEVICE_PRESET_ID = "desktop";
export const TERMINAL_BROWSER_DEFAULT_MOBILE_DEVICE_PRESET_ID = "iphone-se";

export function getTerminalBrowserDevicePreset(
  presetId: TerminalBrowserDevicePresetId,
): TerminalBrowserDevicePreset {
  return (
    TERMINAL_BROWSER_DEVICE_PRESETS.find((preset) => preset.id === presetId) ??
    TERMINAL_BROWSER_DEVICE_PRESETS[0]!
  );
}

export function normalizeTerminalBrowserDevicePresetId(
  value: unknown,
): TerminalBrowserDevicePresetId {
  if (typeof value !== "string") {
    return TERMINAL_BROWSER_DESKTOP_DEVICE_PRESET_ID;
  }
  return TERMINAL_BROWSER_DEVICE_PRESETS.some((preset) => preset.id === value)
    ? (value as TerminalBrowserDevicePresetId)
    : TERMINAL_BROWSER_DESKTOP_DEVICE_PRESET_ID;
}

export function createTerminalBrowserDeviceState(
  presetId: TerminalBrowserDevicePresetId,
): TerminalBrowserDeviceState {
  const preset = getTerminalBrowserDevicePreset(presetId);
  return {
    presetId: preset.id,
    label: preset.label,
    mobile: preset.mobile,
    viewport: preset.viewport ? { ...preset.viewport } : null,
  };
}
