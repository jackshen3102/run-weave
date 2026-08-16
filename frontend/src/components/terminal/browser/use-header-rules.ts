import { useEffect, useState } from "react";
import { normalizeTerminalBrowserHeaderRules, type TerminalBrowserHeaderRule } from "@runweave/shared/terminal-browser-headers";

const HEADER_RULES_STORAGE_KEY = "terminal.browser.headerRules";

export function useTerminalBrowserHeaderRules(isElectron: boolean) {
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
        const rawRules = window.localStorage.getItem(HEADER_RULES_STORAGE_KEY);
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
        const state =
          await window.electronAPI.terminalBrowserSetHeaderRules(
            persistedRules,
          );
        if (!cancelled && state) {
          setHeaderRules(state.rules);
          setHeaderError(null);
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
  }, [isElectron]);

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
      const previousRules = window.localStorage.getItem(
        HEADER_RULES_STORAGE_KEY,
      );
      window.localStorage.setItem(
        HEADER_RULES_STORAGE_KEY,
        JSON.stringify(normalizedRules),
      );
      let state;
      try {
        state =
          await window.electronAPI.terminalBrowserSetHeaderRules(
            normalizedRules,
          );
      } catch (error) {
        if (previousRules === null) {
          window.localStorage.removeItem(HEADER_RULES_STORAGE_KEY);
        } else {
          window.localStorage.setItem(HEADER_RULES_STORAGE_KEY, previousRules);
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
