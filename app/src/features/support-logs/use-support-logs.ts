import { createContext, useContext } from "react";

import type { SupportLogScope, SupportLogStore } from "./support-log-types";

export interface SupportLogContextValue {
  clearSupportLogs(): Promise<void>;
  closeSupportLogs(): void;
  currentScope: SupportLogScope;
  isOpen: boolean;
  openSupportLogs(scope: SupportLogScope): void;
  store: SupportLogStore;
}

export const SupportLogContext =
  createContext<SupportLogContextValue | null>(null);

export function useSupportLogs(): Pick<
  SupportLogContextValue,
  "openSupportLogs"
> {
  const context = useContext(SupportLogContext);
  if (!context) {
    throw new Error("useSupportLogs must be used within SupportLogProvider");
  }
  return {
    openSupportLogs: context.openSupportLogs,
  };
}

export function useSupportLogsInternal(): SupportLogContextValue {
  const context = useContext(SupportLogContext);
  if (!context) {
    throw new Error("SupportLogSheet must be used within SupportLogProvider");
  }
  return context;
}
