import { existsSync, readFileSync } from "node:fs";
import { AgentTeamService } from "../../backend/src/agent-team/service.ts";
import { TerminalStateService } from "../../backend/src/terminal/terminal-state-service.ts";
import { TerminalStateStore } from "../../backend/src/terminal/terminal-state-store.ts";
import { DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT } from "../../packages/shared/src/terminal/agent-preparation.ts";
import { buildRepairRun } from "./repair-fixtures.mjs";
import {
  establishReusableAgentPanel,
  withControlledStartupDelay,
  withHarness,
} from "./bootstrap-lifecycle-harness.mjs";

const FORMAL_WORKER_CASE = {
  caseId: "case_2",
  text: "Code Review must find no blocking P0/P1 issues.",
  status: "pending",
  consecutiveFail: 0,
  evidence: [],
  bouncedToPanelId: null,
};

export async function verifyBootstrapAuthority(check, roots) {
  verifyTuiTextDoesNotAdvanceAuthoritativeState(check);
  await verifyInitialSplitStartsOnlyActiveWorker(check, roots);
  await verifyAgentTeamFormalPromptIsInitialQuery(check, roots);
  await verifyRecheckPromptIsInitialQuery(check, roots);
}

function verifyTuiTextDoesNotAdvanceAuthoritativeState(check) {
  const callbacks = [];
  const cases = [
    {
      terminalSessionId: "codex-ready-text",
      activeCommand: "codex",
      scrollback: "OpenAI Codex\n› ",
      state: { state: "agent_starting", agent: "codex" },
    },
    {
      terminalSessionId: "traex-ready-text",
      activeCommand: "traex",
      scrollback: [
        "TRAE CLI Next",
        "model: GPT-5.4 (MAX)",
        "directory: /tmp/project",
        "permissions: YOLO mode",
        "❯ Inspect the worker queue",
      ].join("\n"),
      state: { state: "agent_starting", agent: "traex" },
    },
  ];
  const store = new TerminalStateStore(
    cases.map((item) => [item.terminalSessionId, item.state]),
  );
  const service = new TerminalStateService(
    store,
    undefined,
    (terminalSessionId, state) => callbacks.push({ terminalSessionId, state }),
  );
  const results = cases.map((item) =>
    service.getCurrent(item.terminalSessionId, {
      activeCommand: item.activeCommand,
      status: "running",
      terminalState: item.state,
      scrollback: item.scrollback,
    }),
  );
  const terminalStateSource = readFileSync(
    new URL(
      "../../backend/src/terminal/terminal-state-service.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const panelWorkspaceSource = readFileSync(
    new URL(
      "../../backend/src/terminal/application/panel-workspace.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const sharedPackageSource = readFileSync(
    new URL("../../packages/shared/package.json", import.meta.url),
    "utf8",
  );
  const sharedReadinessModule = new URL(
    "../../packages/shared/src/terminal-agent-readiness.ts",
    import.meta.url,
  );
  check(
    "bootstrap-tui-text-does-not-advance-authoritative-state",
    results.every((state) => state.state === "agent_starting") &&
      callbacks.length === 0 &&
      !terminalStateSource.includes("hasAgentReadyPrompt") &&
      !terminalStateSource.includes("scrollback") &&
      !panelWorkspaceSource.includes("hasAgentReadyPrompt") &&
      !panelWorkspaceSource.includes("ready-prompt.capture") &&
      !panelWorkspaceSource.includes("capturePane(") &&
      !sharedPackageSource.includes("terminal-agent-readiness") &&
      !existsSync(sharedReadinessModule),
    { results, callbacks },
  );
}

async function verifyInitialSplitStartsOnlyActiveWorker(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const workers = baseRun.workers
      .filter((worker) => worker.role !== "behavior_verify")
      .map((worker) => {
        const workerWithoutPanel = { ...worker };
        delete workerWithoutPanel.panelId;
        delete workerWithoutPanel.tmuxPaneId;
        return workerWithoutPanel;
      });
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      phase: "proposal",
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workers: [],
      acceptance: [],
      proposal: {
        summary: "fixture split",
        workers,
        acceptance: [FORMAL_WORKER_CASE],
        source: "agent",
      },
    };
    harness.setExecutePaneSends(false);
    await withControlledStartupDelay(async (clock) => {
      const split = service.split(run, workers, [FORMAL_WORKER_CASE]);
      await clock.waitForTimer(15_000);
      check(
        "agent-team-initial-split-waits-once-for-active-worker",
        clock.timerCount() === 1 &&
          service.persistedRuns.length === 1 &&
          harness.respawnedPanes.length === 1 &&
          harness.paneOperations.every((item) => item.type !== "send") &&
          harness.manager
            .listPanels(harness.session.id)
            .every((panel) => panel.terminalState?.state === "shell_idle"),
        {
          timerCount: clock.timerCount(),
          persistedRuns: service.persistedRuns,
          respawnedPanes: harness.respawnedPanes,
          paneOperations: harness.paneOperations,
        },
      );
      clock.advanceTo(9_999);
      check(
        "agent-team-initial-split-does-not-send-before-10000ms",
        harness.paneOperations.every((item) => item.type !== "send"),
        harness.paneOperations,
      );
      clock.advanceTo(10_000);
      const result = await split;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send",
      );
      const activeWorker = result.workers.find(
        (worker) => worker.role === result.activeWorkerRole,
      );
      check(
        "agent-team-initial-split-submits-formal-prompt-as-only-initial-query",
        sends.length === 1 &&
          sends[0].paneId === activeWorker?.tmuxPaneId &&
          sends[0].command.includes("你是本 run 的 worker：") &&
          sends[0].command.includes(`任务：${run.task}`) &&
          !sends[0].command.includes(DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT) &&
          service.secondaryPromptCount === 0 &&
          result.workers.filter((worker) => !worker.frozen).length === 1,
        { sends, activeWorker, result },
      );
    });
  });
}

async function verifyAgentTeamFormalPromptIsInitialQuery(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = baseRun.workers.find(
      (worker) => worker.role === "code_review",
    );
    if (!reviewWorker) {
      throw new Error("serial dispatch fixture review worker missing");
    }
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      workers: baseRun.workers.map((worker) =>
        worker.role === "code_review"
          ? {
              ...worker,
              panelId: harness.panel.id,
              tmuxPaneId: harness.panel.tmuxPaneId,
            }
          : worker,
      ),
      acceptance: [FORMAL_WORKER_CASE],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    await withControlledStartupDelay(async (clock) => {
      const dispatch = service.dispatch(run, "code_review", {
        cases: [FORMAL_WORKER_CASE],
        log: "code completed, start review",
      });
      await clock.waitForTimer();
      check(
        "agent-team-serial-dispatch-persists-boundary-before-agent-launch",
        service.persistedRuns.length === 1 &&
          service.persistedRuns[0].activeWorkerRole === "code_review" &&
          service.persistedRuns[0].activeWorkerDispatch?.panelId ===
            harness.panel.id &&
          harness.paneOperations.every((item) => item.type !== "send"),
        {
          persistedRuns: service.persistedRuns,
          paneOperations: harness.paneOperations,
        },
      );
      clock.advanceTo(10_000);
      const result = await dispatch;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send",
      );
      check(
        "agent-team-serial-dispatch-submits-formal-prompt-as-only-initial-query",
        sends.length === 1 &&
          sends[0].paneId === harness.panel.tmuxPaneId &&
          sends[0].command.includes("[loop round") &&
          sends[0].command.includes(FORMAL_WORKER_CASE.text) &&
          !sends[0].command.includes(DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT) &&
          service.secondaryPromptCount === 0 &&
          result.activeWorkerDispatch?.panelId === harness.panel.id,
        {
          sends,
          secondaryPromptCount: service.secondaryPromptCount,
          result,
        },
      );
    });
  });
}

async function verifyRecheckPromptIsInitialQuery(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness, "old-review-thread");
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = {
      ...baseRun.workers.find((worker) => worker.role === "code_review"),
      panelId: harness.panel.id,
      tmuxPaneId: harness.panel.tmuxPaneId,
    };
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      activeWorkerRole: "code_review",
      workers: [reviewWorker],
      acceptance: [FORMAL_WORKER_CASE],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    await withControlledStartupDelay(async (clock) => {
      const recheck = service.recheck(run, harness.session, reviewWorker, [
        FORMAL_WORKER_CASE,
      ]);
      await clock.waitForTimer();
      check(
        "agent-team-recheck-persists-boundary-before-agent-launch",
        clock.timerCount() === 1 &&
          service.persistedRuns.length === 1 &&
          harness.paneOperations.every((item) => item.type !== "send"),
        {
          timerCount: clock.timerCount(),
          persistedRuns: service.persistedRuns,
          paneOperations: harness.paneOperations,
        },
      );
      clock.advanceTo(10_000);
      const result = await recheck;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send",
      );
      check(
        "agent-team-recheck-submits-formal-prompt-as-only-initial-query",
        sends.length === 1 &&
          sends[0].paneId === harness.panel.tmuxPaneId &&
          sends[0].command.includes(FORMAL_WORKER_CASE.text) &&
          !sends[0].command.includes(DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT) &&
          service.secondaryPromptCount === 0 &&
          result.activeWorkerDispatch?.panelId === harness.panel.id,
        { sends, result },
      );
    });
  });
}

class AgentTeamSerialDispatchHarness extends AgentTeamService {
  persistedRuns = [];
  secondaryPromptCount = 0;

  constructor(options) {
    super(options);
    this.promptSender.sendPromptToPane = async () => {
      this.secondaryPromptCount += 1;
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

  recheck(run, session, worker, cases) {
    return this.sendRecheckToWorker(run, session, worker, cases, {
      attempt: 1,
    });
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

