import type { TerminalBrowserMinimumViewportWidth } from "./terminal-browser-minimum-width";

export type TerminalBrowserToolMenuAction =
  | "toggle-annotation"
  | "open-headers"
  | "open-device"
  | "open-devtools"
  | "open-external"
  | "zoom-out"
  | "zoom-in"
  | "reset-zoom"
  | "minimum-width-auto"
  | "minimum-width-768"
  | "minimum-width-1024"
  | "minimum-width-1440";

export interface TerminalBrowserToolMenuRequest {
  x: number;
  y: number;
  showAnnotation: boolean;
  annotationActive: boolean;
  showHeaders: boolean;
  deviceEnabled: boolean;
  devtoolsEnabled: boolean;
  displayScale: number;
  minimumViewportWidth: TerminalBrowserMinimumViewportWidth;
}
