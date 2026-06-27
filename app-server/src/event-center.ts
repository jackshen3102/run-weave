import type {
  AppServerEventEnvelope,
  CreateAppServerEventRequest,
} from "@runweave/shared";
import type { AppServerEventStore, ListEventsOptions } from "./event-store.js";

export type AppServerEventListener = (event: AppServerEventEnvelope) => void;

export class AppServerEventCenter {
  private readonly listeners = new Set<AppServerEventListener>();

  constructor(private readonly store: AppServerEventStore) {}

  async record(
    input: CreateAppServerEventRequest,
  ): Promise<{ event: AppServerEventEnvelope; created: boolean }> {
    const result = await this.store.append(input);
    if (result.created) {
      for (const listener of this.listeners) {
        listener(result.event);
      }
    }
    return result;
  }

  listAfter(options: ListEventsOptions): AppServerEventEnvelope[] {
    return this.store.listAfter(options);
  }

  getLatestId(): string | null {
    return this.store.getLatestId();
  }

  subscribe(listener: AppServerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
