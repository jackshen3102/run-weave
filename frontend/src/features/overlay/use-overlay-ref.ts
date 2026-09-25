import { useMemo, type Ref } from "react";
import { registerOverlay, type OverlayPolicy } from "./registry";

/** Ref identity deliberately follows presence/ownership, unlike an event handler. */
export function useOverlayRef<T extends HTMLElement>(forwarded?: Ref<T>, policy: OverlayPolicy = "intersection", enabled = true) {
  return useMemo(() => (node: T | null) => {
    if (!node) return;
    const release = enabled ? registerOverlay(node, policy) : undefined;
    const releaseForwarded = typeof forwarded === "function" ? forwarded(node) : undefined;
    if (forwarded && typeof forwarded !== "function") forwarded.current = node;
    return () => {
      release?.();
      if (typeof releaseForwarded === "function") releaseForwarded();
      else if (typeof forwarded === "function") forwarded(null);
      else if (forwarded) forwarded.current = null;
    };
  }, [forwarded, policy, enabled]);
}
