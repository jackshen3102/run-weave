import { useCallback, useEffect, useRef } from "react";
import type {
  TerminalEventEnvelope,
  TerminalEventServerMessage,
} from "@browser-viewer/shared";

import { ApiError } from "../services/http";
import { createTerminalEventsWsTicket } from "../services/terminal";

type TerminalEventDelivery = "catchup" | "live";

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

export function useAppTerminalEventsConnection({
  apiBase,
  accessToken,
  enabled = true,
  onAuthExpired,
  onTerminalEvents,
}: {
  apiBase: string;
  accessToken: string;
  enabled?: boolean;
  onAuthExpired: () => void;
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
          if (!cancelled) {
            scheduleReconnect();
          }
        });

        socket.addEventListener("error", () => {
          if (!cancelled) {
            scheduleReconnect();
          }
        });
      } catch (nextError) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        if (!cancelled) {
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      clearReconnectTimer();
      socketRef.current?.close(1000, "AppTerminalEvents unmounted");
      socketRef.current = null;
    };
  }, [apiBase, enabled, handleEvents, onAuthExpired]);
}
