import type { ClientInputMessage } from "@browser-viewer/shared";
import type { ConnectionContext } from "./context";

type DevtoolsMessage = Extract<ClientInputMessage, { type: "devtools" }>;

interface DevtoolsHandlerDeps {
  state: ConnectionContext;
  sendError: (message: string) => void;
  sendAck: () => void;
  emitDevtoolsState: (tabId: string, opened: boolean) => void;
}

export function handleDevtoolsMessage(
  parsed: DevtoolsMessage,
  deps: DevtoolsHandlerDeps,
): void {
  const { state, sendError, sendAck, emitDevtoolsState } = deps;
  if (!state.tabIdToPage.has(parsed.tabId)) {
    sendError(`Unknown tabId: ${parsed.tabId}`);
    return;
  }

  const opened = parsed.action === "open";
  state.devtoolsByTabId.set(parsed.tabId, opened);
  emitDevtoolsState(parsed.tabId, opened);
  sendAck();
}
