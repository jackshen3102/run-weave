import type { Page } from "playwright";
import type { ClientInputMessage } from "@browser-viewer/shared";

function buildKeyboardCommand(key: string, modifiers?: string[]): string {
  if (!modifiers || modifiers.length === 0) {
    return key;
  }
  return `${modifiers.join("+")}+${key}`;
}

export async function applyInputToPage(
  page: Page,
  input: ClientInputMessage,
): Promise<void> {
  switch (input.type) {
    case "mouse": {
      if (input.action === "move") {
        await page.mouse.move(input.x, input.y);
        return;
      }

      await page.mouse.move(input.x, input.y);
      await page.mouse.click(input.x, input.y, {
        button: input.button ?? "left",
      });
      return;
    }
    case "keyboard": {
      await page.keyboard.press(
        buildKeyboardCommand(input.key, input.modifiers),
      );
      return;
    }
    case "clipboard": {
      await page.keyboard.insertText(input.text);
      return;
    }
    case "scroll": {
      if (typeof input.x === "number" && typeof input.y === "number") {
        await page.mouse.move(input.x, input.y);
      }
      await page.mouse.wheel(input.deltaX, input.deltaY);
      return;
    }
    case "tab": {
      throw new Error("Tab input should be handled by websocket server");
    }
    case "navigation": {
      throw new Error("Navigation input should be handled by websocket server");
    }
    case "devtools": {
      throw new Error("DevTools input should be handled by websocket server");
    }
    default: {
      const exhaustiveCheck: never = input;
      throw new Error(`Unsupported input type: ${String(exhaustiveCheck)}`);
    }
  }
}
