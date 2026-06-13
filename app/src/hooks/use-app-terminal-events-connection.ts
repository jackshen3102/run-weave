import { useCallback, useEffect, useRef } from "react";
import type {
  TerminalEventEnvelope,
  TerminalEventServerMessage,
} from "@browser-viewer/shared";

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

function closeWebSocket(socket: WebSocket | null, code: number, reason: string) {
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
  onTerminalEvents: (
    events: TerminalEventEnvelope[],
    delivery: TerminalEventDelivery,
  ) => void;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const accessTokenRef = useRef(accessToken);
  const cursorRef = useRef<string | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const onTerminalEventsRef = useRef(onTerminalEvents);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    onTerminalEventsRef.current = onTerminalEvents;
  }, [onTerminalEvents]);

  const handleEvents = useCallback(
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
        cursorRef.current = maxId;
      }
    },
    [],
  );

  useEffect(() => {
    seenEventIdsRef.current = new Set();
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

        const after = cursorRef.current ?? ticketPayload.baselineEventId;
        const socket = new WebSocket(
          buildTerminalEventsWsUrl(apiBase, ticketPayload.ticket, after),
        );
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (socketRef.current === socket) {
            onTransportOpen?.();
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
            onServerConnected?.();
            return;
          }
          if (message.type === "error" && message.message === "Unauthorized") {
            onAuthExpired();
          }
        });

        socket.addEventListener("close", (event) => {
          if (socketRef.current !== socket) {
            return;
          }
          socketRef.current = null;
          if (event.code === 1008 && event.reason === "Unauthorized") {
            onAuthExpired();
            return;
          }
          scheduleReconnectAfterDecision(() => onConnectionClose?.(event));
        });

        socket.addEventListener("error", () => {
          scheduleReconnectAfterDecision(() => onConnectionError?.());
        });
      } catch (nextError) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          onAuthExpired();
          return;
        }
        scheduleReconnectAfterDecision(() => onConnectionError?.());
      }
    };

    void connect();
    return () => {
      cancelled = true;
      clearReconnectTimer();
      closeWebSocket(socketRef.current, 1000, "AppTerminalEvents unmounted");
      socketRef.current = null;
    };
  }, [
    apiBase,
    enabled,
    handleEvents,
    onAuthExpired,
    onConnectionClose,
    onConnectionError,
    onServerConnected,
    onTransportOpen,
  ]);
}
