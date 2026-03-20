import type { ClientInputMessage } from "@browser-viewer/shared";
import type { BrowserContext } from "playwright";
import type { ConnectionContext } from "./context";
import {
  getNavigationHistory,
  normalizeNavigationUrl,
  stopPageLoading,
} from "./navigation";

type NavigationMessage = Extract<ClientInputMessage, { type: "navigation" }>;

interface NavigationHandlerDeps {
  context: BrowserContext;
  state: ConnectionContext;
  sendError: (message: string) => void;
  sendAck: () => void;
  emitNavigationState: (tabId: string) => Promise<void>;
}

export function handleNavigationMessage(
  parsed: NavigationMessage,
  deps: NavigationHandlerDeps,
): void {
  const { context, state, sendError, sendAck, emitNavigationState } = deps;
  const targetPage = state.tabIdToPage.get(parsed.tabId);
  if (!targetPage) {
    sendError(`Unknown tabId: ${parsed.tabId}`);
    return;
  }

  state.tabLoadingById.set(parsed.tabId, parsed.action !== "stop");
  void emitNavigationState(parsed.tabId);

  void (async () => {
    if (parsed.action === "goto") {
      const normalizedUrl = normalizeNavigationUrl(parsed.url ?? "");
      await targetPage.goto(normalizedUrl, {
        waitUntil: "domcontentloaded",
      });
    } else if (parsed.action === "back") {
      const history = await getNavigationHistory(context, targetPage);
      if (history && history.currentIndex > 0) {
        await targetPage.goBack({ waitUntil: "domcontentloaded" });
      } else {
        state.tabLoadingById.set(parsed.tabId, false);
      }
    } else if (parsed.action === "forward") {
      const history = await getNavigationHistory(context, targetPage);
      if (history && history.currentIndex < history.entryCount - 1) {
        await targetPage.goForward({ waitUntil: "domcontentloaded" });
      } else {
        state.tabLoadingById.set(parsed.tabId, false);
      }
    } else if (parsed.action === "reload") {
      await targetPage.reload({ waitUntil: "domcontentloaded" });
    } else {
      await stopPageLoading(context, targetPage);
      state.tabLoadingById.set(parsed.tabId, false);
    }

    await emitNavigationState(parsed.tabId);
    sendAck();
  })().catch((error) => {
    state.tabLoadingById.set(parsed.tabId, false);
    void emitNavigationState(parsed.tabId);
    sendError(String(error));
  });
}
