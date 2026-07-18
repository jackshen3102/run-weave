export type TerminalBrowserToolMenuAction =
  | "toggle-annotation"
  | "open-headers"
  | "open-device"
  | "open-devtools"
  | "open-external"
  | "zoom-out"
  | "zoom-in"
  | "reset-zoom";

export interface TerminalBrowserToolMenuRequest {
  x: number;
  y: number;
  showAnnotation: boolean;
  annotationActive: boolean;
  showHeaders: boolean;
  deviceEnabled: boolean;
  devtoolsEnabled: boolean;
  displayScale: number;
}
