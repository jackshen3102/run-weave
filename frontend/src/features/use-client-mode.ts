import { useEffect, useState } from "react";
import {
  readClientModeOverride,
  resolveClientMode,
  type ClientMode,
} from "./client-mode";

function resolveCurrentClientMode(isElectron: boolean): ClientMode {
  if (typeof window === "undefined") {
    return "desktop";
  }

  return resolveClientMode({
    viewportWidth: window.innerWidth,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    isElectron,
    override: readClientModeOverride(window.location.search),
  });
}

export function useClientMode(isElectron: boolean): ClientMode {
  const [clientMode, setClientMode] = useState<ClientMode>(() =>
    resolveCurrentClientMode(isElectron),
  );

  useEffect(() => {
    const pointerQuery = window.matchMedia("(pointer: coarse)");
    const syncClientMode = (): void => {
      setClientMode(resolveCurrentClientMode(isElectron));
    };

    syncClientMode();
    window.addEventListener("resize", syncClientMode);
    pointerQuery.addEventListener("change", syncClientMode);

    return () => {
      window.removeEventListener("resize", syncClientMode);
      pointerQuery.removeEventListener("change", syncClientMode);
    };
  }, [isElectron]);

  return clientMode;
}
