import { describe, expect, it, vi } from "vitest";
import { applyInputToPage } from "./input";

describe("applyInputToPage", () => {
  it("applies mouse click and move events", async () => {
    const page = {
      mouse: {
        click: vi.fn(async () => undefined),
        move: vi.fn(async () => undefined),
        wheel: vi.fn(async () => undefined),
      },
      keyboard: {
        press: vi.fn(async () => undefined),
      },
    };

    await applyInputToPage(page as never, {
      type: "mouse",
      action: "move",
      x: 12,
      y: 18,
    });
    await applyInputToPage(page as never, {
      type: "mouse",
      action: "click",
      x: 15,
      y: 20,
      button: "right",
    });

    expect(page.mouse.move).toHaveBeenCalledWith(12, 18);
    expect(page.mouse.click).toHaveBeenCalledWith(15, 20, { button: "right" });
  });

  it("applies keyboard and scroll events", async () => {
    const page = {
      mouse: {
        click: vi.fn(async () => undefined),
        move: vi.fn(async () => undefined),
        wheel: vi.fn(async () => undefined),
      },
      keyboard: {
        press: vi.fn(async () => undefined),
      },
    };

    await applyInputToPage(page as never, {
      type: "keyboard",
      key: "a",
      modifiers: ["Control", "Shift"],
    });
    await applyInputToPage(page as never, {
      type: "scroll",
      x: 40,
      y: 60,
      deltaX: 0,
      deltaY: 120,
    });

    expect(page.keyboard.press).toHaveBeenCalledWith("Control+Shift+a");
    expect(page.mouse.move).toHaveBeenCalledWith(40, 60);
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 120);
  });

  it("rejects tab events", async () => {
    const page = {
      mouse: {
        click: vi.fn(async () => undefined),
        move: vi.fn(async () => undefined),
        wheel: vi.fn(async () => undefined),
      },
      keyboard: {
        press: vi.fn(async () => undefined),
      },
    };

    await expect(
      applyInputToPage(page as never, {
        type: "tab",
        action: "switch",
        tabId: "tab-1",
      }),
    ).rejects.toThrow("Tab input should be handled by websocket server");
  });

  it("rejects navigation events", async () => {
    const page = {
      mouse: {
        click: vi.fn(async () => undefined),
        move: vi.fn(async () => undefined),
        wheel: vi.fn(async () => undefined),
      },
      keyboard: {
        press: vi.fn(async () => undefined),
      },
    };

    await expect(
      applyInputToPage(page as never, {
        type: "navigation",
        action: "reload",
        tabId: "tab-1",
      }),
    ).rejects.toThrow("Navigation input should be handled by websocket server");
  });
});
