import { deviceStorage } from "../../../../features/device-storage";
import { useMemoizedFn } from "ahooks";
import { useEffect, useState } from "react";
import {
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserHeaderState,
} from "@runweave/shared/terminal-browser-headers";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

const LEGACY_HEADER_RULES_STORAGE_KEY = "terminal.browser.headerRules";

function storageKey(profileId: TerminalBrowserProfileId): string {
  return `terminal.browser.headerRules.${profileId}`;
}

export function useTerminalBrowserHeaderRules(
  isElectron: boolean,
  profileId: TerminalBrowserProfileId,
  panelOpen: boolean,
) {
  const [headerRules, setHeaderRules] = useState<TerminalBrowserHeaderRule[]>(
    [],
  );
  const [revision, setRevision] = useState<string>();
  const [headerSaving, setHeaderSaving] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron || panelOpen) {
      return;
    }
    let cancelled = false;
    const loadHeaderRules = async (): Promise<void> => {
      try {
        if (!window.electronAPI?.terminalBrowserGetHeaderRules) throw new Error("Header rules are unavailable");
        const state = await window.electronAPI.terminalBrowserGetHeaderRules(profileId);
        if (cancelled) return;
        setRevision(state.revision);
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
  }, [isElectron, profileId, panelOpen]);

  const onRulesChanged = useMemoizedFn((data: { profileId: TerminalBrowserProfileId; state: TerminalBrowserHeaderState }) => {
    if (data.profileId !== profileId) return;
    // Keep an open draft and its original revision together. Saving it must
    // fail after an external update instead of overwriting the Agent's changes.
    if (panelOpen) {
      setHeaderError("请求头规则已在其他位置更新。请关闭面板后重新打开，再检查并保存。");
    } else {
      setHeaderRules(data.state.rules);
      setRevision(data.state.revision);
      setHeaderError(null);
    }
  });
  useEffect(() => {
    if (!isElectron) return;
    return window.electronAPI?.onTerminalBrowserHeaderRulesChanged?.(onRulesChanged);
  }, [isElectron, onRulesChanged]);

  const saveHeaderRules = async (
    nextRules: TerminalBrowserHeaderRule[],
  ): Promise<boolean> => {
    if (!isElectron) {
      return false;
    }
    setHeaderSaving(true);
    setHeaderError(null);
    try {
      if (!revision) {
        throw new Error("请求头规则版本尚未读取。请关闭面板后重新打开；若仍失败，请更新桌面客户端。");
      }
      const normalizedRules = normalizeTerminalBrowserHeaderRules(nextRules);
      if (!window.electronAPI?.terminalBrowserSetHeaderRules) {
        throw new Error("Header rules are unavailable");
      }
      const state = await window.electronAPI.terminalBrowserSetHeaderRules(profileId, normalizedRules, revision);
      setHeaderRules(state.rules);
      setRevision(state.revision);
      setHeaderError(null);
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
