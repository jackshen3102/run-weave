import { useEffect, useState } from "react";
import {
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserHeaderRule,
} from "@runweave/shared/terminal-browser-headers";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

const LEGACY_HEADER_RULES_STORAGE_KEY = "terminal.browser.headerRules";

function storageKey(profileId: TerminalBrowserProfileId): string {
  return `terminal.browser.headerRules.${profileId}`;
}

export function useTerminalBrowserHeaderRules(
  isElectron: boolean,
  profileId: TerminalBrowserProfileId,
) {
  const [headerRules, setHeaderRules] = useState<TerminalBrowserHeaderRule[]>(
    [],
  );
  const [headerSaving, setHeaderSaving] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    let cancelled = false;
    const loadHeaderRules = async (): Promise<void> => {
      try {
        const profileStorageKey = storageKey(profileId);
        const scopedRules = window.localStorage.getItem(profileStorageKey);
        const legacyRules =
          profileId === "profile-1" && scopedRules === null
            ? window.localStorage.getItem(LEGACY_HEADER_RULES_STORAGE_KEY)
            : null;
        const rawRules = scopedRules ?? legacyRules;
        const persistedRules = rawRules
          ? normalizeTerminalBrowserHeaderRules(JSON.parse(rawRules))
          : [];
        if (cancelled) {
          return;
        }
        setHeaderRules(persistedRules);
        if (!window.electronAPI?.terminalBrowserSetHeaderRules) {
          throw new Error("Header rules are unavailable");
        }
        const state = await window.electronAPI.terminalBrowserSetHeaderRules(
          profileId,
          persistedRules,
        );
        if (!cancelled && state) {
          setHeaderRules(state.rules);
          setHeaderError(null);
          if (legacyRules !== null) {
            window.localStorage.setItem(
              profileStorageKey,
              JSON.stringify(state.rules),
            );
            window.localStorage.removeItem(LEGACY_HEADER_RULES_STORAGE_KEY);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setHeaderRules([]);
          setHeaderError(
            error instanceof Error
              ? error.message
              : "Failed to load header rules",
          );
        }
      }
    };
    void loadHeaderRules();
    return () => {
      cancelled = true;
    };
  }, [isElectron, profileId]);

  const saveHeaderRules = async (
    nextRules: TerminalBrowserHeaderRule[],
  ): Promise<boolean> => {
    if (!isElectron) {
      return false;
    }
    setHeaderSaving(true);
    setHeaderError(null);
    try {
      const normalizedRules = normalizeTerminalBrowserHeaderRules(nextRules);
      if (!window.electronAPI?.terminalBrowserSetHeaderRules) {
        throw new Error("Header rules are unavailable");
      }
      const profileStorageKey = storageKey(profileId);
      const previousRules = window.localStorage.getItem(profileStorageKey);
      window.localStorage.setItem(
        profileStorageKey,
        JSON.stringify(normalizedRules),
      );
      let state;
      try {
        state = await window.electronAPI.terminalBrowserSetHeaderRules(
          profileId,
          normalizedRules,
        );
      } catch (error) {
        if (previousRules === null) {
          window.localStorage.removeItem(profileStorageKey);
        } else {
          window.localStorage.setItem(profileStorageKey, previousRules);
        }
        throw error;
      }
      setHeaderRules(state.rules);
      return true;
    } catch (error) {
      setHeaderError(
        error instanceof Error ? error.message : "Failed to save header rules",
      );
      return false;
    } finally {
      setHeaderSaving(false);
    }
  };

  return {
    headerError,
    headerRules,
    headerSaving,
    saveHeaderRules,
  };
}
