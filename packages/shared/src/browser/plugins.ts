import type { TerminalBrowserProfileId } from "./profile";

export interface BrowserPluginMenuItem {
  id: string;
  label: string;
  enabled?: boolean;
  checked?: boolean;
  children?: BrowserPluginMenuItem[];
}
export interface BrowserPluginSnapshot {
  id: string;
  name: string;
  kind: "builtin" | "chrome";
  enabled: boolean;
  state: "ready" | "disabled" | "error" | "loaded-unverified";
  summary: string;
  detail: string;
  commands: BrowserPluginMenuItem[];
}
export interface BrowserPluginCommand {
  profileId: TerminalBrowserProfileId;
  pluginId: string;
  commandId: string;
}
