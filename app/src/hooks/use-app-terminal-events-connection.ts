import { useMemoizedFn } from "ahooks";
import { useEffect, useRef } from "react";
import type {
  TerminalEventEnvelope,
  TerminalEventServerMessage,
} from "@runweave/shared";

import { classifyApiFailure } from "../services/api-failure";
import { createTerminalEventsWsTicket } from "../services/terminal";

type TerminalEventDelivery = "catchup" | "live";
type ReconnectDecision = boolean | void | Promise<boolean | void>;

function toWebSocketBase(apiBase: string): string {
  const base =
    apiBase ||
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.host}`
      : "");
  if (base.startsWith("https://")) {
    return `wss://${base.slice("https://".length).replace(/\/+$/, "")}`;
  }
  if (base.startsWith("http://")) {
    return `ws://${base.slice("http://".length).replace(/\/+$/, "")}`;
  }
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
  return base.replace(/\/+$/, "");
}

function buildTerminalEventsWsUrl(
  apiBase: string,
  ticket: string,
  after: string | null,
): string {
  const searchParams = new URLSearchParams({
    token: ticket,
    after: after ?? "",
  });
  return `${toWebSocketBase(apiBase)}/ws/terminal-events?${searchParams.toString()}`;
}

function getMaxEventId(events: TerminalEventEnvelope[]): string | null {
  let maxId: string | null = null;
  for (const event of events) {
    if (maxId === null || Number(event.id) > Number(maxId)) {
      maxId = event.id;
    }
  }
  return maxId;
}

function closeWebSocket(
  socket: WebSocket | null,
  code: number,
  reason: string,
) {
  if (!socket) {
    return;
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener("open", () => socket.close(code, reason), {
      once: true,
    });
    return;
  }
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CLOSING
  ) {
    socket.close(code, reason);
  }
}

export function useAppTerminalEventsConnection({
  apiBase,
  accessToken,
  enabled = true,
  onAuthExpired,
  onConnectionClose,
  onConnectionError,
  onServerConnected,
  onTransportOpen,
  onResyncRequired,
  onTerminalEvents,
}: {
  apiBase: string;
  accessToken: string;
  enabled?: boolean;
  onAuthExpired: () => void;
  onConnectionClose?: (event: CloseEvent) => ReconnectDecision;
  onConnectionError?: () => ReconnectDecision;
  onServerConnected?: () => void;
  onTransportOpen?: () => void;
  onResyncRequired: () => void;
  onTerminalEvents: (
    events: TerminalEventEnvelope[],
    delivery: TerminalEventDelivery,
  ) => void;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const accessTokenRef = useRef(accessToken);
  const cursorRef = useRef<string | null>(null);
  const lastConnectionCursorRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const onTerminalEventsRef = useRef(onTerminalEvents);
  const onResyncRequiredRef = useRef(onResyncRequired);
  // Keep callback identities out of the connection effect's dependency array.
  // Otherwise an inline/non-memoized callback (e.g. onConnectionClose) would
  // re-run the effect on every render, tearing down and re-opening the socket
  // and producing a ws-ticket reconnect storm.
  const onAuthExpiredRef = useRef(onAuthExpired);
  const onConnectionCloseRef = useRef(onConnectionClose);
  const onConnectionErrorRef = useRef(onConnectionError);
  const onServerConnectedRef = useRef(onServerConnected);
  const onTransportOpenRef = useRef(onTransportOpen);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    cursorRef.current = null;
    lastConnectionCursorRef.current = null;
    seenEventIdsRef.current = new Set();
    streamIdRef.current = null;
  }, [apiBase]);

  useEffect(() => {
    onTerminalEventsRef.current = onTerminalEvents;
  }, [onTerminalEvents]);

  useEffect(() => {
    onAuthExpiredRef.current = onAuthExpired;
    onConnectionCloseRef.current = onConnectionClose;
    onConnectionErrorRef.current = onConnectionError;
    onServerConnectedRef.current = onServerConnected;
    onTransportOpenRef.current = onTransportOpen;
    onResyncRequiredRef.current = onResyncRequired;
  }, [
    onAuthExpired,
    onConnectionClose,
    onConnectionError,
    onServerConnected,
    onTransportOpen,
    onResyncRequired,
  ]);

  const handleEvents = useMemoizedFn(
    (
      events: TerminalEventEnvelope[],
      delivery: TerminalEventDelivery,
    ): void => {
      const unseenEvents = events.filter((event) => {
        if (seenEventIdsRef.current.has(event.id)) {
          return false;
        }
        seenEventIdsRef.current.add(event.id);
        return true;
      });
      if (unseenEvents.length === 0) {
        return;
      }
      onTerminalEventsRef.current(unseenEvents, delivery);
      const maxId = getMaxEventId(unseenEvents);
      if (maxId) {
        lastConnectionCursorRef.current = maxId;
        cursorRef.current = maxId;
      }
    },
  );

  const resetEventStream = useMemoizedFn((): void => {
    seenEventIdsRef.current = new Set();
    lastConnectionCursorRef.current = null;
    cursorRef.current = null;
    onResyncRequiredRef.current();
  });

  useEffect(() => {
    seenEventIdsRef.current = new Set();
    lastConnectionCursorRef.current = null;
    let cancelled = false;

    if (!enabled || !accessTokenRef.current) {
      return () => {
        cancelled = true;
      };
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, 1200);
    };

    const scheduleReconnectAfterDecision = (
      resolveDecision: () => ReconnectDecision,
    ) => {
      void (async () => {
        const decision = await resolveDecision();
        if (!cancelled && decision !== false) {
          scheduleReconnect();
        }
      })();
    };

    const connect = async () => {
      if (cancelled) {
        return;
      }
      try {
        const ticketPayload = await createTerminalEventsWsTicket(
          apiBase,
          accessTokenRef.current,
        );
        if (cancelled) {
          return;
        }

        let after =
          cursorRef.current ??
          lastConnectionCursorRef.current ??
          ticketPayload.baselineEventId;
        if (
          streamIdRef.current !== null &&
          streamIdRef.current !== ticketPayload.streamId
        ) {
          resetEventStream();
          after = null;
        }
        streamIdRef.current = ticketPayload.streamId;
        lastConnectionCursorRef.current = after;
        const socket = new WebSocket(
          buildTerminalEventsWsUrl(apiBase, ticketPayload.ticket, after),
        );
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (socketRef.current === socket) {
            onTransportOpenRef.current?.();
          }
        });

        socket.addEventListener("message", (event) => {
          if (socketRef.current !== socket || typeof event.data !== "string") {
            return;
          }
          const message = JSON.parse(event.data) as TerminalEventServerMessage;
          if (message.type === "terminal-events") {
            handleEvents(message.events, message.delivery);
            return;
          }
          if (message.type === "terminal-event") {
            handleEvents([message.event], message.delivery);
            return;
          }
          if (message.type === "connected") {
            if (message.streamId !== streamIdRef.current) {
              streamIdRef.current = message.streamId;
              resetEventStream();
              socket.close(1012, "Terminal event stream changed");
              return;
            }
            if (message.gap) {
              resetEventStream();
            }
            onServerConnectedRef.current?.();
            return;
          }
          if (message.type === "error" && message.message === "Unauthorized") {
            onAuthExpiredRef.current();
          }
        });

        socket.addEventListener("close", (event) => {
          if (socketRef.current !== socket) {
            return;
          }
          socketRef.current = null;
          if (event.code === 1008 && event.reason === "Unauthorized") {
            onAuthExpiredRef.current();
            return;
          }
          scheduleReconnectAfterDecision(() =>
            onConnectionCloseRef.current?.(event),
          );
        });

        socket.addEventListener("error", () => {
          scheduleReconnectAfterDecision(() =>
            onConnectionErrorRef.current?.(),
          );
        });
      } catch (nextError) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          onAuthExpiredRef.current();
          return;
        }
        scheduleReconnectAfterDecision(() => onConnectionErrorRef.current?.());
      }
    };

    void connect();
    return () => {
      cancelled = true;
      clearReconnectTimer();
      closeWebSocket(socketRef.current, 1000, "AppTerminalEvents unmounted");
      socketRef.current = null;
    };
  }, [apiBase, enabled, handleEvents, resetEventStream]);
}
