import { createContext, useContext, useEffect, type ReactNode } from "react";
import type {
  RuntimeStatusCapabilityId,
  RuntimeStatusItem,
  RuntimeStatusState,
} from "@runweave/shared/runtime-status";
import type { RuntimeStatusNodeView } from "./registry";

export interface RuntimeStatusContextValue {
  nodes: RuntimeStatusNodeView[];
  currentAddress: string;
  overallState: RuntimeStatusState;
  unhealthyCapabilityIds: RuntimeStatusCapabilityId[];
  refreshing: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  setFrontendItem: (item: RuntimeStatusItem | null, id: string) => void;
}

export const RuntimeStatusContext =
  createContext<RuntimeStatusContextValue | null>(null);

export function useRuntimeStatus(): RuntimeStatusContextValue {
  const value = useContext(RuntimeStatusContext);
  if (!value) {
    throw new Error("RuntimeStatusProvider is missing");
  }
  return value;
}

export function useRuntimeStatusItem(
  item: RuntimeStatusItem | null,
  id: string,
): void {
  const { setFrontendItem } = useRuntimeStatus();
  useEffect(() => {
    setFrontendItem(item, id);
    return () => setFrontendItem(null, id);
  }, [id, item, setFrontendItem]);
}

export function RuntimeStatusConsumer(props: {
  children: (value: RuntimeStatusContextValue) => ReactNode;
}) {
  return props.children(useRuntimeStatus());
}
