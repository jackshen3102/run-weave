import { describe, expect, it } from "vitest";
import { extractKeyboardModifiers, mapClientPointToCanvas } from "./coordinate";

describe("mapClientPointToCanvas", () => {
  it("maps client coordinates to canvas coordinates", () => {
    const rect = {
      left: 100,
      top: 200,
      width: 320,
      height: 180,
    } as DOMRect;

    const mapped = mapClientPointToCanvas(260, 290, rect, 1280, 720);
    expect(mapped).toEqual({ x: 640, y: 360 });
  });

  it("clamps out-of-bounds coordinates", () => {
    const rect = {
      left: 10,
      top: 10,
      width: 100,
      height: 50,
    } as DOMRect;

    const mapped = mapClientPointToCanvas(500, -50, rect, 200, 100);
    expect(mapped).toEqual({ x: 200, y: 0 });
  });
});

describe("extractKeyboardModifiers", () => {
  it("extracts active keyboard modifiers", () => {
    const modifiers = extractKeyboardModifiers({
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: true,
    });

    expect(modifiers).toEqual(["Control", "Alt", "Shift"]);
  });
});
