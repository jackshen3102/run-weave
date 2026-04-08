import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  loadTerminalPreferences,
  saveTerminalPreferences,
} from "./preferences";

describe("terminal preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when storage is empty", () => {
    expect(loadTerminalPreferences("http://localhost:5001")).toEqual(
      DEFAULT_TERMINAL_PREFERENCES,
    );
  });

  it("merges stored preferences with defaults", () => {
    localStorage.setItem(
      "viewer.terminal.preferences.http://localhost:5001",
      JSON.stringify({
        fontSize: 15,
        renderer: "canvas",
      }),
    );

    expect(loadTerminalPreferences("http://localhost:5001")).toEqual({
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontSize: 15,
      renderer: "canvas",
    });
  });

  it("sanitizes invalid stored values", () => {
    localStorage.setItem(
      "viewer.terminal.preferences.http://localhost:5001",
      JSON.stringify({
        fontSize: 200,
        renderer: "broken",
        cursorBlink: "yes",
        bellMode: "loud",
      }),
    );

    expect(loadTerminalPreferences("http://localhost:5001")).toEqual(
      DEFAULT_TERMINAL_PREFERENCES,
    );
  });

  it("persists merged preference updates", () => {
    saveTerminalPreferences("http://localhost:5001", {
      fontSize: 14,
      copyOnSelect: true,
    });
    saveTerminalPreferences("http://localhost:5001", {
      renderer: "dom",
      bellMode: "sound",
    });

    expect(loadTerminalPreferences("http://localhost:5001")).toEqual({
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontSize: 14,
      copyOnSelect: true,
      renderer: "dom",
      bellMode: "sound",
    });
  });
});
