import { useMemo, useRef, type RefObject } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalScrollInput, TerminalScrollStop, TerminalScrollState } from "@runweave/shared/terminal/websocket";
import { sendMessage } from "./socket-transport";

export function useTerminalScrollTransport(socket: RefObject<WebSocket | null>, onState?: (state: TerminalScrollState) => void) {
  const enabled = useRef(false);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const reset = useMemoizedFn(() => { enabled.current = false; });
  const receive = useMemoizedFn((state: TerminalScrollState) => onStateRef.current?.(state));
  const sendScroll = useMemoizedFn((message: TerminalScrollInput | TerminalScrollStop) => { sendMessage(socket.current, message); });
  const requestScrollState = useMemoizedFn(() => { sendMessage(socket.current, { type: "request-status" }); });
  return useMemo(() => ({ enabled, reset, receive,
    connection: { normalizedScrollRef: enabled, sendScroll, requestScrollState },
  }), [reset, receive, sendScroll, requestScrollState]);
}
