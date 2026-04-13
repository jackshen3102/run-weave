import {
  TERMINAL_CLIENT_SCROLLBACK_LINES,
  TERMINAL_LIVE_SCROLLBACK_BYTES,
} from "@browser-viewer/shared";
import {
  createScrollbackBuffer,
  readScrollbackBuffer,
} from "./scrollback-buffer";

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
  return readScrollbackBuffer(
    createScrollbackBuffer(
      limitScrollbackLines(scrollback, TERMINAL_CLIENT_SCROLLBACK_LINES),
      TERMINAL_LIVE_SCROLLBACK_BYTES,
    ),
  );
}
