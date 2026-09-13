import { createContext, useContext } from "react";

export const CodexQuotaContext = createContext<(() => void) | null>(null);
export function useOpenCodexQuota() { return useContext(CodexQuotaContext); }
