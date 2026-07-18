import type { AgentTeamRun } from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import { findWorkerByRole } from "./service-workflow-policy";
import { createSyntheticCompletionEvent } from "./service-run-policy";
import { AgentTeamCompletionRecheckService } from "./service-completion-recheck";
import type {
  AgentTeamCompletionSignal,
  AgentTeamCompletionSignalSource,
} from "./service-types";

export abstract class AgentTeamCompletionSignalService extends AgentTeamCompletionRecheckService {
  protected abstract reconcileCompletionEvent(
    event: Extract<TerminalEventEnvelope, { kind: "completion" }>,
    source: AgentTeamCompletionSignalSource,
  ): Promise<boolean>;

  protected async handleTerminalEvent(
    event: TerminalEventEnvelope,
  ): Promise<void> {
    if (event.kind !== "completion") {
      return;
    }
    await this.reconcileCompletionEvent(event, "terminal_event");
  }

  async reconcileCompletionSignal(
    signal: AgentTeamCompletionSignal,
  ): Promise<boolean> {
    const run: AgentTeamRun | null =
      await this.runStore.getRunByTerminalSession(
        signal.projectId,
        signal.terminalSessionId,
      );
    if (!run || run.phase !== "executing" || run.status !== "running") {
      return false;
    }
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    const activeWorker = run.activeWorkerRole
      ? findWorkerByRole(run.workers, run.activeWorkerRole)
      : null;
    if (!session) {
      return false;
    }
    return this.reconcileCompletionEvent(
      createSyntheticCompletionEvent(run, session, activeWorker, signal),
      signal.source,
    );
  }
}
