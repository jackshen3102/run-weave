import { deviceStorage } from "../../../../features/device-storage";
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
        if (!window.electronAPI?.terminalBrowserGetHeaderRules) throw new Error("Header rules are unavailable");
        const state = await window.electronAPI.terminalBrowserGetHeaderRules(profileId);
        if (cancelled) return;
        if (!state.configured) {
          const rawRules = deviceStorage.getItem(storageKey(profileId)) ?? (profileId === "profile-1" ? deviceStorage.getItem(LEGACY_HEADER_RULES_STORAGE_KEY) : null);
          if (rawRules !== null) {
            setHeaderRules(normalizeTerminalBrowserHeaderRules(JSON.parse(rawRules)));
            setHeaderError("检测到旧请求头规则。请检查后点击保存，迁入当前桌面配置；旧规则暂未应用。");
            return;
          }
        }
        setHeaderRules(state.rules);
        setHeaderError(null);
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
      const state = await window.electronAPI.terminalBrowserSetHeaderRules(profileId, normalizedRules);
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
