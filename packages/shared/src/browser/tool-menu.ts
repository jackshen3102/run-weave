import type { TerminalBrowserMinimumViewportWidth } from "./minimum-width";
import type { TerminalBrowserProfileId } from './profile';

export type TerminalBrowserToolMenuAction =
  | "open-bookmarks"
  | "toggle-bookmark-bar"
  | "new-bookmark-folder"
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
  profileId?: TerminalBrowserProfileId;
  bookmarkBarVisible?: boolean;
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
