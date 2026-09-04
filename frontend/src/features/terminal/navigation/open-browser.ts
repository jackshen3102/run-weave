import {
  TERMINAL_BROWSER_DEFAULT_PROFILE_ID,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { normalizeTerminalBrowserUrl } from "./browser-url";

type TerminalBrowserPlacement =
  | { kind: "new-group" }
  | { kind: "current-group"; groupId: string; openerTabId: string };

export async function openTerminalBrowserUrl(input: {
  url: string;
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
  await window.electronAPI.terminalBrowserCreateTab(
    input.placement.kind === "current-group"
      ? {
          profileId,
          placement: "current-group",
          groupId: input.placement.groupId,
          openerTabId: input.placement.openerTabId,
          url: normalized.url,
        }
      : { profileId, placement: "new-group", url: normalized.url },
  );
  return profileId;
}
