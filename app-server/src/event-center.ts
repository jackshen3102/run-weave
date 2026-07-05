import type {
  AppServerAgentSessionStateChangedPayload,
  AppServerEventEnvelope,
  AppServerThreadStateChangedPayload,
  CreateAppServerEventRequest,
} from "@runweave/shared";
import type { AppServerCloudSyncSim } from "./cloud-sync-sim.js";
import type { AppServerEventStore, ListEventsOptions } from "./event-store.js";
import type { AppServerStateProjector } from "./state-projector.js";
import type { AppServerStateStore } from "./state-store.js";

export type AppServerEventListener = (event: AppServerEventEnvelope) => void;

export interface AppServerEventCenterOptions {
  sourceInstanceId: string;
  stateStore: AppServerStateStore;
  stateProjector: AppServerStateProjector;
  cloudSync: AppServerCloudSyncSim;
}

export class AppServerEventCenter {
  private readonly listeners = new Set<AppServerEventListener>();

  constructor(
    private readonly store: AppServerEventStore,
    private readonly options: AppServerEventCenterOptions,
  ) {}

  async record(
    input: CreateAppServerEventRequest,
  ): Promise<{ event: AppServerEventEnvelope; created: boolean }> {
    const result = await this.store.append(input);
    if (result.created) {
      const derivedEvents = await this.projectAndRecordDerivedEvents(result.event);
      await this.syncCloud(
        derivedEvents
          .filter((event) => event.kind === "thread.state.changed")
          .map((event) => {
            const payload = event.payload as AppServerThreadStateChangedPayload;
            return payload.thread;
          }),
        derivedEvents
          .filter((event) => event.kind === "agent_session.state.changed")
          .map((event) => {
            const payload =
              event.payload as AppServerAgentSessionStateChangedPayload;
            return payload.agentSession;
          }),
      );
      this.notify(result.event);
      for (const event of derivedEvents) {
        this.notify(event);
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

  getStateStore(): AppServerStateStore {
    return this.options.stateStore;
  }

  getSyncStatus() {
    return this.options.cloudSync.getStatus();
  }

  subscribe(listener: AppServerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async projectAndRecordDerivedEvents(
    event: AppServerEventEnvelope,
  ): Promise<AppServerEventEnvelope[]> {
    const projection = this.options.stateProjector.project(event);
    const derivedInputs: CreateAppServerEventRequest[] = [];
    if (projection.threadChange?.changed) {
      derivedInputs.push({
        kind: "thread.state.changed",
        source: {
          app: "app-server",
          instanceId: this.options.sourceInstanceId,
          pid: process.pid,
        },
        scope: {
          projectId: projection.threadChange.current.projectId,
          terminalSessionId: projection.threadChange.current.terminalSessionId,
          terminalPanelId: projection.threadChange.current.terminalPanelId,
          runId: projection.threadChange.current.runId,
          cwd: projection.threadChange.current.cwd,
        },
        correlationId: projection.threadChange.current.threadId,
        payload: {
          thread: projection.threadChange.current,
          previous: projection.threadChange.previous,
        } satisfies AppServerThreadStateChangedPayload,
      });
    }
    if (projection.agentSessionChange?.changed) {
      derivedInputs.push({
        kind: "agent_session.state.changed",
        source: {
          app: "app-server",
          instanceId: this.options.sourceInstanceId,
          pid: process.pid,
        },
        scope: {
          projectId: projection.agentSessionChange.current.projectId,
          terminalSessionId:
            projection.agentSessionChange.current.terminalSessionId,
          terminalPanelId:
            projection.agentSessionChange.current.terminalPanelId,
          runId: projection.agentSessionChange.current.runId,
          cwd: projection.agentSessionChange.current.cwd,
        },
        correlationId: projection.agentSessionChange.current.threadId,
        payload: {
          agentSession: projection.agentSessionChange.current,
          previous: projection.agentSessionChange.previous,
        } satisfies AppServerAgentSessionStateChangedPayload,
      });
    }

    const derivedEvents: AppServerEventEnvelope[] = [];
    for (const input of derivedInputs) {
      const result = await this.store.append(input);
      if (result.created) {
        derivedEvents.push(result.event);
      }
    }
    if (derivedEvents.length > 0) {
      await this.options.stateStore.persist();
    }
    return derivedEvents;
  }

  private async syncCloud(
    threadChanges: ReturnType<AppServerStateStore["listThreads"]>,
    agentSessionChanges: ReturnType<AppServerStateStore["listAgentSessions"]>,
  ): Promise<void> {
    const snapshot = this.options.stateStore.getSnapshot();
    await this.options.cloudSync.sync({
      events: this.store.listAll(),
      threads: snapshot.threads,
      agentSessions: snapshot.agentSessions,
      threadChanges,
      agentSessionChanges,
    });
  }

  private notify(event: AppServerEventEnvelope): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
