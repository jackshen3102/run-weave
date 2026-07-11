import type { WebSocket } from "ws";
import type {
  AppServerEventEnvelope,
  AppServerEventStreamMessage,
} from "@runweave/shared";
import { logger } from "../logging";
import type { AppServerClient } from "./client";
import type { AppServerEventCursorStore } from "./event-cursor-store";

export interface AppServerEventConsumerOptions {
  client: AppServerClient;
  cursorStore: AppServerEventCursorStore;
  consumerId: string;
  kinds: string[];
  isRelevant: (event: AppServerEventEnvelope) => boolean;
  handler: (event: AppServerEventEnvelope) => Promise<void>;
}

export interface AppServerEventConsumerHandle {
  start(): Promise<void>;
  stop(): void;
}

const eventConsumerLogger = logger.child({
  component: "app-server-event-consumer",
});

export class AppServerEventConsumer implements AppServerEventConsumerHandle {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1000;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AppServerEventConsumerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    const cursor = await this.options.cursorStore.read(this.options.consumerId);
    this.connect(cursor);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(after: string | null): void {
    if (this.stopped) {
      return;
    }
    this.socket = this.options.client.connectStream({
      after,
      kinds: this.options.kinds,
      onMessage: (message) => this.enqueueMessage(message),
      onClose: () => this.scheduleReconnect(),
      onError: (error) => this.handleSocketError(error),
    });
    eventConsumerLogger.info("app-server.consumer.started", {
      message: "App-server event consumer started",
      consumerId: this.options.consumerId,
      kinds: this.options.kinds,
      after,
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const cursor = await this.options.cursorStore.read(
        this.options.consumerId,
      );
      this.connect(cursor);
    }, delay);
  }

  private handleSocketError(error: Error): void {
    eventConsumerLogger.warn("app-server.consumer.socket.error", {
      message: "App-server event stream socket error",
      consumerId: this.options.consumerId,
      error,
    });
    this.socket?.terminate();
    this.socket = null;
    this.scheduleReconnect();
  }

  private enqueueMessage(message: AppServerEventStreamMessage): void {
    this.queue = this.queue
      .then(() => this.handleMessage(message))
      .catch((error: unknown) => {
        eventConsumerLogger.error("app-server.consumer.message.failed", {
          message: "App-server event message handling failed",
          consumerId: this.options.consumerId,
          error,
        });
      });
  }

  private async handleMessage(
    message: AppServerEventStreamMessage,
  ): Promise<void> {
    if (message.type === "connected") {
      this.reconnectDelayMs = 1000;
      return;
    }
    if (message.type === "events") {
      for (const event of message.events) {
        await this.handleEvent(event);
      }
      return;
    }
    if (message.type === "event") {
      await this.handleEvent(message.event);
    }
  }

  private async handleEvent(event: AppServerEventEnvelope): Promise<void> {
    if (this.options.isRelevant(event)) {
      await this.options.handler(event);
    }
    await this.options.cursorStore.write(this.options.consumerId, event.id);
  }
}
