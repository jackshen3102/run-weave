import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AttentionOpenIntent,
  AttentionOpenResult,
  CompanionPresentationState,
  CompanionWindowDragRequest,
} from "@runweave/shared/attention";
import type { RunweaveCompanionBridge } from "@runweave/shared/desktop-bridge";
import { DesktopCompanion } from "./components/desktop-companion/desktop-companion";

type NativeCommand =
  | { type: "ready" }
  | { type: "resize"; width: number; height: number }
  | { type: "drag"; request: CompanionWindowDragRequest }
  | { type: "openSlot"; commandId: string; intent: AttentionOpenIntent };

type NativeEvent =
  | { type: "presentation"; presentation: CompanionPresentationState }
  | { type: "openResult"; commandId: string; result: AttentionOpenResult };

declare global {
  interface Window {
    runweaveCompanionReceive?: (event: NativeEvent) => void;
    webkit?: {
      messageHandlers?: {
        runweave?: { postMessage: (command: NativeCommand) => void };
      };
    };
  }
}

const initialPresentation: CompanionPresentationState = {
  connectionId: null,
  snapshot: null,
  state: "checking",
};

const pendingOpenRequests = new Map<
  string,
  (result: AttentionOpenResult) => void
>();

function postNative(command: NativeCommand): void {
  window.webkit?.messageHandlers?.runweave?.postMessage(command);
}

const companionBridge: RunweaveCompanionBridge = {
  reportContentSize: ({ width, height }) => {
    postNative({ type: "resize", width, height });
    return Promise.resolve();
  },
  setMousePassthrough: () => Promise.resolve(),
  dragWindow: (request) => postNative({ type: "drag", request }),
  openSlot: (intent) =>
    new Promise((resolve) => {
      const commandId = crypto.randomUUID();
      pendingOpenRequests.set(commandId, resolve);
      postNative({ type: "openSlot", commandId, intent });
    }),
};

window.companionAPI = companionBridge;

function CompanionRoot() {
  const [presentation, setPresentation] =
    useState<CompanionPresentationState>(initialPresentation);

  useEffect(() => {
    window.runweaveCompanionReceive = (event) => {
      if (event.type === "presentation") {
        setPresentation(event.presentation);
        return;
      }
      const resolve = pendingOpenRequests.get(event.commandId);
      if (!resolve) return;
      pendingOpenRequests.delete(event.commandId);
      resolve(event.result);
    };
    postNative({ type: "ready" });
    return () => {
      delete window.runweaveCompanionReceive;
      pendingOpenRequests.clear();
    };
  }, []);

  return <DesktopCompanion presentation={presentation} />;
}

createRoot(document.getElementById("root")!).render(<CompanionRoot />);
