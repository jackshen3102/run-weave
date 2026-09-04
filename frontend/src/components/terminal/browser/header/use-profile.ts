import { useEffect, useState } from "react";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { useTerminalPreviewStore } from "../../../../features/terminal/preview/store";

interface TerminalBrowserProfileResolutionOptions {
  active: boolean;
  activationProjectId: string | null;
  activationRevision: number;
  isElectron: boolean;
  profileId: TerminalBrowserProfileId;
  syncElectronTabs: (force?: boolean) => Promise<void>;
  setElectronTabsSynced: (synced: boolean) => void;
}

export function useTerminalBrowserProfileResolution({
  active,
  activationProjectId,
  activationRevision,
  isElectron,
  profileId,
  setElectronTabsSynced,
  syncElectronTabs,
}: TerminalBrowserProfileResolutionOptions) {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron || !active || activationRevision <= 0) return;
    let cancelled = false;
    setElectronTabsSynced(false);
    setResolving(true);
    setError(null);
    const currentTabId = useTerminalPreviewStore.getState().browser.activeTabId;
    void Promise.resolve(
      currentTabId
        ? window.electronAPI?.terminalBrowserHide?.(currentTabId)
        : undefined,
    )
      .then(() =>
        window.electronAPI?.terminalBrowserResolveProfile?.({
          projectId: activationProjectId,
          explicitProfileId: profileId,
          browserGroupId: null,
        }),
      )
      .then(async () => {
        if (!cancelled) await syncElectronTabs(true);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to resolve Terminal Browser Profile",
        );
        setElectronTabsSynced(true);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activationProjectId,
    activationRevision,
    active,
    isElectron,
    profileId,
    setElectronTabsSynced,
    syncElectronTabs,
  ]);

  return { profileError: error, profileResolving: resolving };
}
