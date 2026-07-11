import { useMemoizedFn } from "ahooks";
import { useEffect, useState } from "react";
import type { TerminalBrowserProxyState } from "@runweave/shared/terminal-browser-proxy";

export function useTerminalBrowserProxy(isElectron: boolean) {
  const [state, setState] = useState<TerminalBrowserProxyState | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    let cancelled = false;
    void window.electronAPI
      ?.terminalBrowserGetProxyState?.()
      .then((next) => {
        if (!cancelled && next) {
          setState(next);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Failed to load proxy state",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  const toggle = useMemoizedFn(async (): Promise<void> => {
    if (!isElectron || switching) {
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      const next = await window.electronAPI?.terminalBrowserSetProxyEnabled?.(
        !(state?.enabled ?? false),
      );
      if (next) {
        setState(next);
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to switch proxy",
      );
    } finally {
      setSwitching(false);
    }
  });

  return { error, state, switching, toggle };
}
