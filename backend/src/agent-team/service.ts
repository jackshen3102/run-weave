import { agentTeamLogger } from "./service/context";
import { AgentTeamExportService } from "./service/export/index";

export type {
  AgentTeamCompletionSignal,
  AgentTeamCompletionSignalSource,
  AgentTeamServiceOptions,
  ExportAgentTeamRunOptions,
} from "./service/types";

export class AgentTeamService extends AgentTeamExportService {
  private unsubscribe: (() => void) | null = null;
  private disposal: Promise<void> | null = null;

  initialize(): void {
    if (this.unsubscribe || this.stopping) return;
    this.unsubscribe = this.terminalEventService.subscribe((event) => {
      if (this.stopping) return;
      this.trackBackgroundTask(this.handleTerminalEvent(event).catch((error) => {
        agentTeamLogger.error("agent-team.terminal_event.failed", {
          message: "Failed to handle terminal event",
          eventId: event.id,
          terminalSessionId: event.terminalSessionId,
          kind: event.kind,
          error,
        });
      }));
    });
    this.startRecheckWatchdog();
    this.trackBackgroundTask(this.runRecheckWatchdog("startup").catch((error) => {
      agentTeamLogger.warn("agent-team.completion_recovery.startup_failed", {
        message: "Could not scan active worker outboxes during startup",
        error,
      });
    }));
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.stopping = true;
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.recheckWatchdogTimer) clearInterval(this.recheckWatchdogTimer);
      this.recheckWatchdogTimer = null;
      this.disposal = this.drainBackgroundTasks();
    }
    return this.disposal;
  }

  private async drainBackgroundTasks(): Promise<void> {
    await Promise.allSettled([...this.backgroundTasks]);
    await Promise.allSettled([...this.eventQueues.values()]);
  }
}
