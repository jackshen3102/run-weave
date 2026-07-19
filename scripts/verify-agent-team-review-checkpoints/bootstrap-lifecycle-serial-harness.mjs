import { AgentTeamService } from "../../backend/src/agent-team/service.ts";
import { getAgentForCommand } from "../../backend/src/terminal/terminal-state-service.ts";

export class AgentTeamSerialDispatchHarness extends AgentTeamService {
  persistedRuns = [];
  secondaryPromptCount = 0;
  secondaryPrompts = [];
  resumedThreads = [];

  constructor(options) {
    super(options);
    this.promptSender.sendPromptToPane = async (_session, text, target) => {
      this.secondaryPromptCount += 1;
      this.secondaryPrompts.push({ text, target });
    };
    this.agentLaunch.submitAgentResume = async (session, terminal, target) => {
      this.resumedThreads.push({ session, terminal, target });
      const agent = getAgentForCommand(terminal.command ?? null);
      if (!agent) {
        throw new Error("resume fixture requires a supported terminal agent");
      }
      await this.terminalSessionManager.updatePanelThreadId(
        target.panelId,
        target.threadId,
        agent,
      );
      await this.terminalSessionManager.updatePanelTerminalState(
        target.panelId,
        {
          state: "agent_idle",
          agent,
        },
      );
    };
  }

  dispatch(run, role, options) {
    return this.dispatchSerialWorker(run, role, options);
  }

  split(run, workers, acceptance) {
    return this.applySplit(run, workers, acceptance, {
      source: "agent",
      log: "fixture split",
    });
  }

  prepareInitial(input, projectRoot) {
    return this.prepareInitialAcceptance(input, projectRoot);
  }

  recheck(run, session, worker, cases) {
    return this.sendRecheckToWorker(run, session, worker, cases, {
      attempt: 1,
    });
  }

  round(run, params) {
    return this.applyRound(run, params);
  }

  async updateRun(run, patch) {
    const next = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.persistedRuns.push(next);
    return next;
  }
}
