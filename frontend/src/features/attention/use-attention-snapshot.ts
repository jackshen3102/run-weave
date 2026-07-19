import { useEffect, useState } from "react";
import type { AttentionSnapshot } from "@runweave/shared/attention";
import { fetchAttentionSnapshot } from "../../services/attention";

export type AttentionLoadState = "checking" | "ready" | "disconnected";

export function useAttentionSnapshot(params: {
  apiBase: string;
  token: string | null;
  connectionId: string | null;
}): { state: AttentionLoadState; snapshot: AttentionSnapshot | null } {
  const { apiBase, token, connectionId } = params;
  const [state, setState] = useState<AttentionLoadState>("checking");
  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null);

  useEffect(() => {
    if (!apiBase || !token || !connectionId) {
      setSnapshot(null);
      setState("disconnected");
      return;
    }
    let disposed = false;
    let controller: AbortController | null = null;
    const refresh = (): void => {
      controller?.abort();
      controller = new AbortController();
      void fetchAttentionSnapshot(apiBase, token, controller.signal)
        .then((value) => {
          if (!disposed) {
            setSnapshot(value);
            setState("ready");
          }
        })
        .catch(() => {
          if (!disposed && !controller?.signal.aborted) {
            setSnapshot(null);
            setState("disconnected");
          }
        });
    };
    setState("checking");
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [apiBase, connectionId, token]);

  return { state, snapshot };
}
