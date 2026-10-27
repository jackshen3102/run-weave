import type { BrowserWindow, WebContents } from "electron";
import type {
  BrowserPluginMenuItem,
  BrowserPluginSnapshot,
} from "@runweave/shared/browser-plugins";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

interface PageEvents {
  "did-start-navigation": [Electron.Event, string, boolean, boolean];
  "did-navigate": [Electron.Event, string];
  "did-navigate-in-page": [Electron.Event, string, boolean];
  "page-title-updated": [Electron.Event, string, boolean];
  "did-finish-load": [];
  "did-stop-loading": [];
}
export interface BrowserPluginPage {
  contents: WebContents;
  profileId: TerminalBrowserProfileId;
  pageId: string;
  groupId: () => string;
  kind: "tab" | "popup";
  restoring: boolean;
  displayUrl: (url: string) => string;
  listen<K extends keyof PageEvents>(
    event: K,
    callback: (...args: PageEvents[K]) => void,
  ): void;
}
export type BrowserPluginPageInput = Omit<BrowserPluginPage, "listen">;
export interface BrowserPluginContext {
  window: BrowserWindow;
  profileId: TerminalBrowserProfileId;
}
/** Built-in, reviewed application code only. Chrome packages never implement this interface. */
export interface BrowserPlugin {
  id: string;
  name: string;
  kind: BrowserPluginSnapshot["kind"];
  start?(): Promise<void>;
  status(
    profile: TerminalBrowserProfileId,
  ): Pick<BrowserPluginSnapshot, "enabled" | "state" | "summary" | "detail">;
  commands(profile: TerminalBrowserProfileId): BrowserPluginMenuItem[];
  run(context: BrowserPluginContext, commandId: string): Promise<void>;
  attach?(page: BrowserPluginPage): (() => void) | void;
  stop?(): Promise<void>;
}
