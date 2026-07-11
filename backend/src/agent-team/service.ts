import { agentTeamLogger } from "./service-context";
import { AgentTeamExportService } from "./service-export";

export type {
  AgentTeamCompletionSignal,
  AgentTeamCompletionSignalSource,
  AgentTeamServiceOptions,
  ExportAgentTeamRunOptions,
} from "./service-types";

export class AgentTeamService extends AgentTeamExportService {
  initialize(): void {
    this.terminalEventService.subscribe((event) => {
      void this.handleTerminalEvent(event).catch((error) => {
        agentTeamLogger.error("agent-team.terminal_event.failed", {
          message: "Failed to handle terminal event",
          eventId: event.id,
          terminalSessionId: event.terminalSessionId,
          kind: event.kind,
          error,
        });
      });
    });
    this.startRecheckWatchdog();
    void this.runRecheckWatchdog("startup").catch((error) => {
      agentTeamLogger.warn("agent-team.completion_recovery.startup_failed", {
        message: "Could not scan active worker outboxes during startup",
        error,
      });
    });
  }
}
