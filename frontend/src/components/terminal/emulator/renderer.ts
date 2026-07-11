import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import type { TerminalRendererPreference } from "../../../features/terminal/preferences";

export function installTerminalRenderer(
  terminal: Terminal,
  preference: TerminalRendererPreference,
): { dispose(): void } | null {
  const loadCanvas = (): { dispose(): void } | null => {
    try {
      const canvas = new CanvasAddon();
      terminal.loadAddon(canvas);
      return canvas;
    } catch {
      return null;
    }
  };

  const loadWebgl = (allowCanvasFallback: boolean) => {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (allowCanvasFallback) {
          loadCanvas();
        }
      });
      terminal.loadAddon(webgl);
      return webgl;
    } catch {
      return loadCanvas();
    }
  };

  if (preference === "dom") {
    return null;
  }
  if (preference === "canvas") {
    return loadCanvas();
  }
  if (preference === "webgl") {
    return loadWebgl(false);
  }
  return loadWebgl(true);
}
