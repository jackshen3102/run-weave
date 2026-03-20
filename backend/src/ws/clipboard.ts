import type { ClientInputMessage } from "@browser-viewer/shared";
import type { Page } from "playwright";

type KeyboardMessage = Extract<ClientInputMessage, { type: "keyboard" }>;

function hasShortcutModifier(modifiers: string[] | undefined): boolean {
  if (!modifiers) {
    return false;
  }

  return modifiers.includes("Control") || modifiers.includes("Meta");
}

export function isCopyOrCutShortcut(input: ClientInputMessage): boolean {
  if (input.type !== "keyboard") {
    return false;
  }

  const normalizedKey = input.key.toLowerCase();
  if (normalizedKey !== "c" && normalizedKey !== "x") {
    return false;
  }

  return hasShortcutModifier(input.modifiers);
}

export async function readSelectedText(page: Page): Promise<string | null> {
  const value = await page.evaluate(() => {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement
    ) {
      const start = activeElement.selectionStart;
      const end = activeElement.selectionEnd;
      if (start !== null && end !== null && end > start) {
        return activeElement.value.slice(start, end);
      }
    }

    const selection = window.getSelection()?.toString() ?? "";
    return selection;
  });

  if (!value) {
    return null;
  }

  return value;
}

export async function getClipboardCopyTextBeforeInput(
  page: Page,
  input: ClientInputMessage,
): Promise<string | null> {
  if (!isCopyOrCutShortcut(input)) {
    return null;
  }

  return readSelectedText(page);
}

export function truncateClipboardText(text: string, maxLength = 65536): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function buildCopyEventPayload(text: string): {
  type: "clipboard";
  action: "copy";
  text: string;
} {
  return {
    type: "clipboard",
    action: "copy",
    text: truncateClipboardText(text),
  };
}

export type { KeyboardMessage };
