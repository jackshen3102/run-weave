import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientInputMessage } from "@browser-viewer/shared";
import { useViewerConnection } from "./use-viewer-connection";

type MessageHandler = (event: { data: string }) => void;
type OpenHandler = () => void;
type CloseHandler = (event: { code: number; reason: string }) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly sent: string[] = [];
  onopen: OpenHandler | null = null;
  onmessage: MessageHandler | null = null;
  onclose: CloseHandler | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.emitClose(1000, "");
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    for (const listener of this.listeners.get("open") ?? []) {
      (listener as OpenHandler)();
    }
  }

  emitMessage(payload: unknown): void {
    const event = { data: JSON.stringify(payload) };
    this.onmessage?.(event);
    for (const listener of this.listeners.get("message") ?? []) {
      (listener as MessageHandler)(event);
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    const event = { code, reason };
    this.onclose?.(event);
    for (const listener of this.listeners.get("close") ?? []) {
      (listener as CloseHandler)(event);
    }
  }
}

function Probe() {
  const canvasRef = {
    current: document.createElement("canvas"),
  } as RefObject<HTMLCanvasElement | null>;
  const connection = useViewerConnection({
    apiBase: "http://localhost:5000",
    sessionId: "session-1",
    token: "token-1",
    canvasRef,
  });

  return (
    <div>
      <span data-testid="status">{connection.status}</span>
      <button
        type="button"
        onClick={() => {
          connection.sendInput({
            type: "tab",
            action: "switch",
            tabId: "tab-2",
          } satisfies ClientInputMessage);
        }}
      >
        Switch
      </button>
    </div>
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

async function connectOnce(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

describe("useViewerConnection", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    window.history.replaceState(null, "", "/viewer/session-1");
    globalThis.createImageBitmap = vi.fn();
  });

  afterEach(() => {
    cleanup();
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it("persists the selected tab id to the URL immediately on switch", async () => {
    render(<Probe />);
    await connectOnce();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.emitOpen();
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    expect(window.location.search).toContain("tabId=tab-2");
  });

  it("falls back URL tab selection to the first tab when the requested tab is missing", async () => {
    window.history.replaceState(null, "", "/viewer/session-1?tabId=missing");
    render(<Probe />);
    await connectOnce();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.emitOpen();
      socket?.emitMessage({
        type: "tabs",
        tabs: [
          {
            id: "tab-1",
            title: "Tab 1",
            url: "https://example.com",
            active: true,
          },
          {
            id: "tab-2",
            title: "Tab 2",
            url: "https://example.org",
            active: false,
          },
        ],
      });
    });

    expect(window.location.search).toContain("tabId=tab-1");
    expect(window.location.search).not.toContain("tabId=missing");
  });
});
