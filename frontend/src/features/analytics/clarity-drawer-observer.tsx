import { useEffect } from "react";
import { useSuijiDrawer } from "../suiji/drawer-state";
import { useTunnelStore } from "../tunnels/store";
import { reportClarityDrawerOpen } from "./clarity";

export function ClarityDrawerObserver() {
  useEffect(() => {
    // Subscribe to transitions directly so React batching cannot lose an open.
    const unsubscribeSuiji = useSuijiDrawer.subscribe((state, before) => {
      if (state.open && !before.open) reportClarityDrawerOpen("suiji");
    });
    const unsubscribeTunnels = useTunnelStore.subscribe((state, before) => {
      if (state.open && !before.open && window.electronAPI?.isElectron === true) {
        reportClarityDrawerOpen("tunnels");
      }
    });
    return () => {
      unsubscribeSuiji();
      unsubscribeTunnels();
    };
  }, []);

  return null;
}
