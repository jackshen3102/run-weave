import {
  TERMINAL_BROWSER_DEFAULT_PROFILE_ID,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { normalizeTerminalBrowserUrl } from "./browser-url";
import type { DesktopLocalBrowserSource } from "@runweave/shared/browser-local-tunnel";

type TerminalBrowserPlacement =
  | { kind: "new-group" }
  | { kind: "active-group" }
  | { kind: "current-group"; groupId: string; openerTabId: string };

export async function openTerminalBrowserUrl(input: {
  url: string;
  source?: DesktopLocalBrowserSource;
  projectId?: string | null;
  profileId?: TerminalBrowserProfileId;
  placement: TerminalBrowserPlacement;
}): Promise<TerminalBrowserProfileId | null> {
  const normalized = normalizeTerminalBrowserUrl(input.url);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  if (
    window.electronAPI?.isElectron !== true ||
    !window.electronAPI.terminalBrowserCreateTab
  ) {
    window.open(normalized.url, "_blank", "noopener,noreferrer");
    return null;
  }

  const preferences = input.profileId
    ? null
    : await window.electronAPI.terminalBrowserGetProfilePreferences?.();
  const profileId =
    input.profileId ??
    (input.projectId
      ? preferences?.worktrees[input.projectId]?.preferredProfileId
      : null) ??
    preferences?.defaultProfileId ??
    TERMINAL_BROWSER_DEFAULT_PROFILE_ID;
  let placement = input.placement;
  if (placement.kind === "active-group") {
    const workspace = await window.electronAPI.terminalBrowserGetWorkspace?.(profileId);
    const opener = workspace?.tabs.find((tab) => tab.tabId === workspace.activeTabId);
    placement = opener
      ? { kind: "current-group", groupId: opener.browserGroupId, openerTabId: opener.tabId }
      : { kind: "new-group" };
  }
  await window.electronAPI.terminalBrowserCreateTab(
    placement.kind === "current-group"
      ? {
          profileId,
          placement: "current-group",
          groupId: placement.groupId,
          openerTabId: placement.openerTabId,
          url: normalized.url,
          source: input.source,
        }
      : { profileId, placement: "new-group", url: normalized.url, source: input.source },
  );
  return profileId;
}
