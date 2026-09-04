import { useEffect, useState } from "react";
import { useAttentionSnapshot } from "./use-attention-snapshot";

export function useDesktopCompanionHost(props: {
  apiBase: string;
  token: string | null;
  connectionId: string | null;
  enabled: boolean;
}): void {
  const [companionEnabled, setCompanionEnabled] = useState(false);
  const { snapshot, state } = useAttentionSnapshot({
    apiBase: props.apiBase,
    token: props.token,
    connectionId: props.connectionId,
    enabled: props.enabled && companionEnabled,
  });

  useEffect(() => {
    const bridge = window.electronAPI;
    if (
      !props.enabled ||
      !bridge?.getCompanionEnabled ||
      !bridge.onCompanionEnabledChanged
    ) {
      return;
    }
    let disposed = false;
    const unsubscribe = bridge.onCompanionEnabledChanged(setCompanionEnabled);
    void bridge
      .getCompanionEnabled()
      .then((value) => {
        if (!disposed) setCompanionEnabled(value);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [props.enabled]);

  useEffect(() => {
    if (!props.enabled || !companionEnabled) return;
    void window.electronAPI
      ?.publishCompanionPresentation?.({
        connectionId: props.connectionId,
        snapshot,
        state,
      })
      .catch(() => undefined);
  }, [companionEnabled, props.connectionId, props.enabled, snapshot, state]);
}
