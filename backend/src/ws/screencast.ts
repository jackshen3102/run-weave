import type { BrowserContext } from "playwright";
import type { WebSocket } from "ws";
import type { ConnectionContext } from "./context";

export function createScreencastController(params: {
  socket: WebSocket;
  state: ConnectionContext;
  context: BrowserContext;
  sessionId: string;
}): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const { socket, state, context, sessionId } = params;

  const onScreencastFrame = (payload: {
    data: string;
    sessionId: number;
  }): void => {
    if (socket.readyState !== 1) {
      return;
    }

    const frameBuffer = Buffer.from(payload.data, "base64");
    socket.send(frameBuffer, { binary: true });
    void state.cdpSession?.send("Page.screencastFrameAck", {
      sessionId: payload.sessionId,
    });
  };

  const start = async (): Promise<void> => {
    state.cdpSession = await context.newCDPSession(state.activePage);
    await state.cdpSession.send("DOM.enable");
    await state.cdpSession.send("CSS.enable");
    state.cdpSession.on("Page.screencastFrame", onScreencastFrame);
    await state.cdpSession.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 720,
    });
    console.log("[viewer-be] screencast started", {
      sessionId,
      activeTabId: state.activeTabId,
    });
  };

  const stop = async (): Promise<void> => {
    if (!state.cdpSession) {
      return;
    }

    state.cdpSession.off("Page.screencastFrame", onScreencastFrame);
    await state.cdpSession.send("Page.stopScreencast").catch(() => undefined);
    await state.cdpSession.detach().catch(() => undefined);
    state.cdpSession = null;
    console.log("[viewer-be] screencast stopped", {
      sessionId,
      activeTabId: state.activeTabId,
    });
  };

  return { start, stop };
}
