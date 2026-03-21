import type { ClientInputMessage } from "@browser-viewer/shared";

type TabMessage = Extract<ClientInputMessage, { type: "tab" }>;

export function handleTabMessage(params: {
  parsed: TabMessage;
  selectTab: (tabId: string) => Promise<boolean>;
  createTab: () => Promise<void>;
  sendError: (message: string) => void;
  sendAck: () => void;
}): void {
  const { parsed, selectTab, createTab, sendError, sendAck } = params;

  if (parsed.action === "create") {
    void createTab()
      .then(() => {
        sendAck();
      })
      .catch((error) => {
        sendError(String(error));
      });
    return;
  }

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
