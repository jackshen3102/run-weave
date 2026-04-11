import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";

function limitScrollbackLines(scrollback: string, maxLines: number): string {
  if (!scrollback) {
    return scrollback;
  }

  const lines = scrollback.split("\n");
  if (lines.length <= maxLines) {
    return scrollback;
  }

  return lines.slice(-maxLines).join("\n");
}

export function getLiveTerminalScrollback(scrollback: string): string {
  return limitScrollbackLines(scrollback, TERMINAL_CLIENT_SCROLLBACK_LINES);
}
