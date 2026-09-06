import type { AppServerRuntimeStatusSourceHandle } from "../app-server/runtime-status-source";
import type { AppServerEventConsumerHandle } from "../app-server/event-consumer";
import type { AgentTeamService } from "../agent-team/service";
import type { EvolutionRuntime } from "../evolution/runtime";
import {
  createBackendRuntimeStatusReport,
  type BackendRuntimeStatusInput,
} from "./provider";
import { RuntimeStatusRegistry } from "./registry";

export class BackendRuntimeStatusService {
  readonly registry: RuntimeStatusRegistry;
  listener: { baseUrl: string; host: string; port: number } | null = null;
  appServerSource: AppServerRuntimeStatusSourceHandle | null = null;
  eventConsumer: AppServerEventConsumerHandle | null = null;

  constructor(
    serviceInstanceId: string,
    private readonly dependencies: {
      activityStoreAvailable: boolean;
      agentTeamService: AgentTeamService;
      evolutionRuntime: EvolutionRuntime;
      workspaceServiceManager: BackendRuntimeStatusInput["workspaceServiceManager"];
    },
  ) {
    this.registry = new RuntimeStatusRegistry(serviceInstanceId);
    this.registry.registerProvider("backend", () => {
      return createBackendRuntimeStatusReport({
        serviceInstanceId: this.registry.serviceInstanceId,
        listener: this.listener,
        activityStoreAvailable: this.dependencies.activityStoreAvailable,
        eventConsumer: this.eventConsumer?.getStatusSnapshot() ?? null,
        watchdog: this.dependencies.agentTeamService.getRecheckWatchdogStatus(),
        evolution: this.dependencies.evolutionRuntime.getStatusSnapshot(),
        workspaceServiceManager: this.dependencies.workspaceServiceManager,
      });
    });
  }

  dispose(): void {
    this.eventConsumer?.stop();
    this.appServerSource?.stop();
    this.registry.dispose();
  }
}
