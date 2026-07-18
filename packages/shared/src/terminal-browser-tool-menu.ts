export type TerminalBrowserToolMenuAction =
  | "toggle-annotation"
  | "submit-annotations"
  | "open-headers"
  | "open-device"
  | "open-devtools"
  | "open-external";

export interface TerminalBrowserToolMenuRequest {
  x: number;
  y: number;
  showAnnotation: boolean;
  annotationActive: boolean;
  annotationSubmitEnabled: boolean;
  showHeaders: boolean;
  deviceEnabled: boolean;
  devtoolsEnabled: boolean;
}
