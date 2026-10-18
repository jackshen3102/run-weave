import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useMemoizedFn } from "ahooks";
import { useTerminalRuntime } from "../terminal/queries/provider";
import { SideChatApi } from "../../services/side-chat";
import { sideChatKey, sideChatModel, useSideChatNavigation } from "./model";
export function useSideChat(terminalId: string | null, panelId: string | null, poll = false) {
  const { apiBase, token, activeConnectionId } = useTerminalRuntime();
  const scope = `${activeConnectionId ?? "web"}::${apiBase}`;
  const key = sideChatKey(scope, terminalId ?? "");
  const api = useMemo(() => new SideChatApi(apiBase, token), [apiBase, token]);
  const model = useMemo(() => sideChatModel(key, api, terminalId ?? "", panelId), [key, api, terminalId, panelId]);
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const navigation = useSideChatNavigation(store => store.entries[key]);
  useEffect(() => { if (poll && terminalId) return model.start(); }, [model, poll, terminalId]);
  const open = useMemoizedFn(() => { void model.open(); });
  return { model, state, visible: navigation?.visible ?? false, open };
}
