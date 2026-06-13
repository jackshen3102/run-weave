import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TerminalEventEnvelope,
  TerminalEventServerMessage,
} from "@runweave/shared";
import { HttpError } from "../../services/http";
import { createTerminalEventsWsTicket } from "../../services/terminal";
import { getTerminalReconnectDelay } from "./reconnect-policy";
import { toWebSocketBase } from "./url";

type ConnectionStatus = "connecting" | "connected" | "closed";
type TerminalEventDelivery = "catchup" | "live";

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

export function useTerminalEventsConnection(params: {
  apiBase: string;
  token: string;
  getCursor: () => string | null;
  setCursor: (cursor: string) => void;
  onAuthExpired?: () => void;
  onTerminalEvents: (
    events: TerminalEventEnvelope[],
    delivery: TerminalEventDelivery,
  ) => void;
}) {
  const {
    apiBase,
    token,
    getCursor,
    setCursor,
    onAuthExpired,
    onTerminalEvents,
  } = params;
  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef(token);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const closeReasonRef = useRef<string | null>(null);
  const getCursorRef = useRef(getCursor);
  const setCursorRef = useRef(setCursor);
  const onTerminalEventsRef = useRef(onTerminalEvents);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    getCursorRef.current = getCursor;
  }, [getCursor]);
  useEffect(() => {
    setCursorRef.current = setCursor;
  }, [setCursor]);
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
        setCursorRef.current(maxId);
      }
    },
    [],
  );

  useEffect(() => {
    setConnectionStatus("connecting");
    setError(null);
    seenEventIdsRef.current = new Set();
    let cancelled = false;

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current === null) {
        return;
      }
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };

    const connect = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      clearReconnectTimer();
      setConnectionStatus("connecting");
      setError(null);

      try {
        const ticketPayload = await createTerminalEventsWsTicket(
          apiBase,
          tokenRef.current,
        );
        if (cancelled) {
          return;
        }

        const after = getCursorRef.current() ?? ticketPayload.baselineEventId;
        const socket = new WebSocket(
          buildTerminalEventsWsUrl(apiBase, ticketPayload.ticket, after),
        );
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (socketRef.current !== socket) {
            return;
          }
          closeReasonRef.current = null;
          setConnectionStatus("connected");
          reconnectCountRef.current = 0;
        });

        socket.addEventListener("close", (event) => {
          if (socketRef.current !== socket) {
            return;
          }
          socketRef.current = null;

          if (event.code === 1008 && event.reason === "Unauthorized") {
            setConnectionStatus("closed");
            onAuthExpired?.();
            return;
          }

          if (!cancelled) {
            const reconnectAttempt = reconnectCountRef.current;
            reconnectCountRef.current = reconnectAttempt + 1;
            setConnectionStatus("connecting");
            clearReconnectTimer();
            reconnectTimerRef.current = window.setTimeout(() => {
              void connect();
            }, getTerminalReconnectDelay(reconnectAttempt));
            return;
          }

          setConnectionStatus("closed");
          if (closeReasonRef.current || event.reason) {
            setError(
              closeReasonRef.current ||
                event.reason ||
                "Terminal events connection closed.",
            );
          }
        });

        socket.addEventListener("message", (event) => {
          if (socketRef.current !== socket) {
            return;
          }

          try {
            const parsed = JSON.parse(
              String(event.data),
            ) as TerminalEventServerMessage;
            if (parsed.type === "connected") {
              return;
            }
            if (parsed.type === "terminal-events") {
              handleEvents(parsed.events, parsed.delivery);
              return;
            }
            if (parsed.type === "terminal-event") {
              handleEvents([parsed.event], parsed.delivery);
              return;
            }
            if (parsed.type === "error") {
              closeReasonRef.current = parsed.message;
              setError(parsed.message);
              if (parsed.message === "Unauthorized") {
                onAuthExpired?.();
              }
            }
          } catch {
            closeReasonRef.current = "Invalid terminal events message";
            setError("Invalid terminal events message");
          }
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }

        setError(String(error));
        const reconnectAttempt = reconnectCountRef.current;
        reconnectCountRef.current = reconnectAttempt + 1;
        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          void connect();
        }, getTerminalReconnectDelay(reconnectAttempt));
      }
    };

    const connectTimer = window.setTimeout(() => {
      void connect();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(connectTimer);
      clearReconnectTimer();
      reconnectCountRef.current = 0;
      closeReasonRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [apiBase, handleEvents, onAuthExpired]);

  return {
    connectionStatus,
    error,
  };
}
