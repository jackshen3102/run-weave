import type {
  OrchestratorRoleDefinition,
  TerminalAgentKind,
} from "@runweave/shared";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../../terminal/manager";
import type { PtyService } from "../../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../../terminal/runtime-registry";
import type { TmuxOutputWatcher } from "../../terminal/tmux-output-watcher";
import type { TmuxService } from "../../terminal/tmux-service";
import {
  getAgentForCommand,
  type TerminalStateService,
} from "../../terminal/terminal-state-service";
import { sendInputToSession } from "../../routes/terminal-input-dispatcher";
import { OrchestratorError } from "../errors";
import type { AgentSnapshot } from "../types";

const ORCHESTRATOR_AGENT_START_TIMEOUT_MS = 15000;
const ORCHESTRATOR_AGENT_START_POLL_INTERVAL_MS = 250;
const CODEX_TRUST_PROMPT_PATTERN =
  /Do you trust the contents of this directory\?|Press enter to continue/;
const CODEX_READY_PATTERN = /OpenAI Codex/;
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export class OrchestratorAgentReadinessService {
  constructor(
    private readonly options: {
      terminalSessionManager: TerminalSessionManager;
      ptyService: PtyService;
      runtimeRegistry: TerminalRuntimeRegistry;
      terminalStateService: TerminalStateService;
      tmuxService?: TmuxService;
      tmuxOutputWatcher?: TmuxOutputWatcher;
    },
  ) {}

  async ensureOrchestratorAgentReady(
    session: TerminalSessionRecord,
    terminal: OrchestratorRoleDefinition["terminal"],
  ): Promise<void> {
    const agent = resolveOrchestratorAgent(terminal.command);
    if (!agent) {
      return;
    }

    const initial = this.getAgentSnapshot(session.id, session);
    if (
      isRequestedAgentReady(initial, agent) &&
      (await this.isAgentUiReady(session.id, agent))
    ) {
      return;
    }
    if (initial.currentAgent && initial.currentAgent !== agent) {
      throw new OrchestratorError(
        409,
        `Orchestrator terminal is already using agent "${initial.currentAgent}"`,
      );
    }

    const latest = this.requireSession(session.id);
    await sendInputToSession(
      this.options.terminalSessionManager,
      {
        runtimeRegistry: this.options.runtimeRegistry,
        ptyService: this.options.ptyService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
        terminalStateService: this.options.terminalStateService,
      },
      latest,
      terminal.command?.trim() || agent,
      "line",
      `orchestrator_agent_start_${Date.now()}`,
    );
    await this.waitForOrchestratorAgent(session.id, agent);
  }

  private async waitForOrchestratorAgent(
    terminalSessionId: string,
    agent: TerminalAgentKind,
  ): Promise<void> {
    const deadline = Date.now() + ORCHESTRATOR_AGENT_START_TIMEOUT_MS;
    let latest = this.getAgentSnapshot(terminalSessionId);
    while (Date.now() <= deadline) {
      latest = this.getAgentSnapshot(terminalSessionId);
      await this.acceptCodexTrustPromptIfNeeded(terminalSessionId, agent);
      if (
        isRequestedAgentReady(latest, agent) &&
        (await this.isAgentUiReady(terminalSessionId, agent))
      ) {
        return;
      }
      await wait(ORCHESTRATOR_AGENT_START_POLL_INTERVAL_MS);
    }

    throw new OrchestratorError(
      409,
      `Timed out waiting for orchestrator agent "${agent}" to start. Last state=${latest.terminalState.state}, agent=${latest.terminalState.agent ?? "none"}, activeCommand=${latest.activeCommand ?? "none"}`,
    );
  }

  private getAgentSnapshot(
    terminalSessionId: string,
    fallback?: TerminalSessionRecord,
  ): AgentSnapshot {
    const session =
      this.options.terminalSessionManager.getSession(terminalSessionId) ?? fallback;
    if (!session) {
      throw new OrchestratorError(404, "Terminal session not found");
    }
    const terminalState = this.options.terminalStateService.getCurrent(
      terminalSessionId,
      session,
    );
    const currentAgent =
      (terminalState.state !== "shell_idle" ? terminalState.agent : null) ??
      getAgentForCommand(session.activeCommand);
    return {
      activeCommand: session.activeCommand,
      currentAgent,
      terminalState,
    };
  }

  private requireSession(terminalSessionId: string): TerminalSessionRecord {
    const session =
      this.options.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      throw new OrchestratorError(404, "Terminal session not found");
    }
    return session;
  }

  private async acceptCodexTrustPromptIfNeeded(
    terminalSessionId: string,
    agent: TerminalAgentKind,
  ): Promise<void> {
    if (agent !== "codex") {
      return;
    }
    const scrollback = await this.readCleanLiveScrollback(terminalSessionId);
    if (!hasPendingCodexTrustPrompt(scrollback)) {
      return;
    }
    const session = this.requireSession(terminalSessionId);
    await sendInputToSession(
      this.options.terminalSessionManager,
      {
        runtimeRegistry: this.options.runtimeRegistry,
        ptyService: this.options.ptyService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
        terminalStateService: this.options.terminalStateService,
      },
      session,
      "",
      "line",
      `orchestrator_agent_trust_${Date.now()}`,
    );
  }

  private async isAgentUiReady(
    terminalSessionId: string,
    agent: TerminalAgentKind,
  ): Promise<boolean> {
    if (agent !== "codex") {
      return true;
    }
    const scrollback = await this.readCleanLiveScrollback(terminalSessionId);
    return hasStartedCodexUi(scrollback);
  }

  private async readCleanLiveScrollback(
    terminalSessionId: string,
  ): Promise<string> {
    const scrollback =
      await this.options.terminalSessionManager.readLiveScrollback(
        terminalSessionId,
      );
    return stripTerminalControlSequences(scrollback);
  }
}

function resolveOrchestratorAgent(
  command: string | undefined,
): TerminalAgentKind | null {
  return getAgentForCommand(command ?? null);
}

function isRequestedAgentReady(
  snapshot: AgentSnapshot,
  agent: TerminalAgentKind,
): boolean {
  return snapshot.terminalState.state !== "shell_idle" && snapshot.currentAgent === agent;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasPendingCodexTrustPrompt(scrollback: string): boolean {
  const trustPromptIndex = findLastIndex(scrollback, CODEX_TRUST_PROMPT_PATTERN);
  if (trustPromptIndex < 0) {
    return false;
  }
  const readyIndex = findLastIndex(scrollback, CODEX_READY_PATTERN);
  return readyIndex < trustPromptIndex;
}

function hasStartedCodexUi(scrollback: string): boolean {
  const readyIndex = findLastIndex(scrollback, CODEX_READY_PATTERN);
  if (readyIndex < 0) {
    return false;
  }
  const trustPromptIndex = findLastIndex(scrollback, CODEX_TRUST_PROMPT_PATTERN);
  return readyIndex > trustPromptIndex;
}

function findLastIndex(value: string, pattern: RegExp): number {
  let latest = -1;
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of value.matchAll(globalPattern)) {
    latest = match.index ?? latest;
  }
  return latest;
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(/\r/g, "");
}
