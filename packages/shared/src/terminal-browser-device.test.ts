import { describe, expect, it } from "vitest";
import {
  TERMINAL_BROWSER_DEFAULT_MOBILE_DEVICE_PRESET_ID,
  createTerminalBrowserDeviceState,
  normalizeTerminalBrowserDevicePresetId,
} from "./terminal-browser-device";

describe("terminal browser devices", () => {
  it("normalizes known preset ids", () => {
    expect(normalizeTerminalBrowserDevicePresetId("iphone-se")).toBe(
      TERMINAL_BROWSER_DEFAULT_MOBILE_DEVICE_PRESET_ID,
    );
    expect(normalizeTerminalBrowserDevicePresetId("iphone-14")).toBe(
      "iphone-14",
    );
    expect(normalizeTerminalBrowserDevicePresetId("pixel-7")).toBe("pixel-7");
  });

  it("falls back to desktop for unknown preset ids", () => {
    expect(normalizeTerminalBrowserDevicePresetId("ipad-mini")).toBe("desktop");
    expect(normalizeTerminalBrowserDevicePresetId(null)).toBe("desktop");
  });

  it("creates readonly snapshots for mobile presets", () => {
    expect(createTerminalBrowserDeviceState("iphone-se")).toEqual({
      presetId: "iphone-se",
      label: "iPhone SE",
      mobile: true,
      viewport: { width: 375, height: 667, deviceScaleFactor: 2 },
    });
  });
});
