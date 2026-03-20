import type { ClientInputMessage } from "@browser-viewer/shared";

type TabMessage = Extract<ClientInputMessage, { type: "tab" }>;

export function handleTabMessage(params: {
  parsed: TabMessage;
  selectTab: (tabId: string) => Promise<boolean>;
  sendError: (message: string) => void;
  sendAck: () => void;
}): void {
  const { parsed, selectTab, sendError, sendAck } = params;

  void selectTab(parsed.tabId)
    .then((switched) => {
      if (!switched) {
        sendError(`Unknown tabId: ${parsed.tabId}`);
        return;
      }
      sendAck();
    })
    .catch((error) => {
      sendError(String(error));
    });
}
