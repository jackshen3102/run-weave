import {
  AgentTeamAgentReadinessService,
  hasMatchingAgentReadinessOwner,
} from "../../backend/src/agent-team/agent-readiness.ts";
import {
  appendToScrollbackBuffer,
  captureScrollbackBufferCursor,
  createScrollbackBuffer,
  readScrollbackBufferSince,
} from "../../backend/src/terminal/scrollback-buffer.ts";
import { ensureTmuxPanelWorkspace } from "../../backend/src/terminal/application/panel-workspace.ts";

let recordCheck = null;

function check(...args) {
  return recordCheck(...args);
}

export function buildTraeReadyScrollback(suggestion) {
  return [
    "TRAE CLI Next",
    "model: GPT-5.4 (MAX)",
    "directory: /tmp/project",
    "permissions: YOLO mode",
    "───────────────────────────────",
    `❯ ${suggestion}`,
    "───────────────────────────────",
    "  GPT-5.4 (MAX) ▰ Full Access",
  ].join("\n");
}

export function buildTraeMetadataScrollback() {
  return [
    "TRAE CLI Next",
    "model: GPT-5.4 (MAX)",
    "directory: /tmp/project",
    "permissions: YOLO mode",
  ].join("\n");
}

async function verifyOrdinaryTraePanelReadyRefresh() {
  const now = new Date();
  const session = {
    id: "ordinary-trae-ready",
    projectId: "project",
    command: "/bin/zsh",
    args: ["-l"],
    cwd: "/tmp/project",
    activeCommand: "traex",
    terminalState: { state: "agent_starting", agent: "traex" },
    status: "running",
    runtimeKind: "tmux",
    tmuxSessionName: "runweave-ordinary-trae-ready",
    tmuxSocketPath: "/tmp/runweave-ordinary-trae-ready.sock",
    panelSplitEnabled: true,
    createdAt: now,
    lastActivityAt: now,
  };
  const panel = {
    id: "ordinary-panel",
    terminalSessionId: session.id,
    alias: "main",
    role: "main",
    agentTeamRunId: null,
    agentTeamWorkerId: null,
    cwd: session.cwd,
    activeCommand: "traex",
    terminalState: { state: "agent_starting", agent: "traex" },
    status: "running",
    createdAt: now,
    lastActivityAt: now,
    runtimeKind: "tmux",
    tmuxPaneId: "%1",
  };
  const workspace = {
    terminalSessionId: session.id,
    activePanelId: panel.id,
    panelIds: [panel.id],
    renderMode: "tmux-native",
  };
  const capturedTargets = [];
  let panelStateUpdates = 0;
  let sessionStateUpdates = 0;
  const terminalSessionManager = {
    listPanels() {
      return [panel];
    },
    getPanelWorkspace() {
      return workspace;
    },
    getPanel() {
      return panel;
    },
    async upsertPanel(nextPanel) {
      Object.assign(panel, nextPanel);
      panelStateUpdates += 1;
      return panel;
    },
    async updateSessionTerminalState(_terminalSessionId, terminalState) {
      session.terminalState = terminalState;
      sessionStateUpdates += 1;
      return session;
    },
  };
  const tmuxService = {
    async listPanes() {
      return [
        {
          paneId: panel.tmuxPaneId,
          cwd: panel.cwd,
          activeCommand: "traex",
          activeCommandSource: "runweave_command",
          paneCommand: "traex",
          active: true,
          runweavePanelId: panel.id,
        },
      ];
    },
    async capturePane(target) {
      capturedTargets.push(target);
      return {
        data: buildTraeReadyScrollback("Explain this codebase"),
        durationMs: 1,
      };
    },
  };

  await ensureTmuxPanelWorkspace(terminalSessionManager, session, tmuxService);

  check(
    "ordinary-trae-ready-refresh-persists-panel-idle",
    panel.terminalState.state === "agent_idle" &&
      panel.terminalState.agent === "traex" &&
      session.terminalState.state === "agent_idle" &&
      session.terminalState.agent === "traex" &&
      panelStateUpdates === 1 &&
      sessionStateUpdates === 1 &&
      capturedTargets.length === 1 &&
      capturedTargets[0]?.paneId === panel.tmuxPaneId,
    JSON.stringify({
      panelTerminalState: panel.terminalState,
      sessionTerminalState: session.terminalState,
      panelStateUpdates,
      sessionStateUpdates,
      capturedTargets,
    }),
  );
}

async function verifyTraeReadinessOwner() {
  const readyScrollback = buildTraeReadyScrollback("Review the active branch");
  const staleOutput = Array.from(
    { length: 80 },
    (_, index) => `stale-output-${index}`,
  );
  const session = {
    id: "trae-stale-shell",
    projectId: "project",
    command: "/bin/zsh",
    args: ["-l"],
    cwd: "/tmp/project",
    activeCommand: null,
    scrollback: [
      "Status: old",
      readyScrollback,
      ...staleOutput,
      "➜  project git:(main) ✗",
    ].join("\n"),
    status: "running",
    runtimeKind: "pty",
    panelSplitEnabled: false,
  };
  const writes = [];
  const outputChunks = ["historical-output"];
  let startupOutputReads = 0;
  let scrollbackReads = 0;
  let startingTransitions = 0;
  let idleTransitions = 0;
  const runtime = {
    write(value) {
      writes.push(value);
      session.activeCommand = "traex";
      session.scrollback = [
        "Status: launching",
        readyScrollback,
        ...staleOutput,
        "➜  project git:(main) ✗ traex",
      ].join("\n");
      outputChunks.push("➜  project git:(main) ✗ traex\n");
    },
  };
  const terminalStateService = {
    getCurrent() {
      return session.activeCommand
        ? { state: "agent_starting", agent: "traex" }
        : { state: "shell_idle", agent: null };
    },
    setAgentStarting() {
      startingTransitions += 1;
      return { state: "agent_starting", agent: "traex" };
    },
    setAgentIdle() {
      idleTransitions += 1;
      return { state: "agent_idle", agent: "traex" };
    },
  };
  const service = new AgentTeamAgentReadinessService({
    terminalSessionManager: {
      async captureOutputCursor() {
        return outputChunks.length;
      },
      readOutputSince(_terminalSessionId, cursor) {
        startupOutputReads += 1;
        if (startupOutputReads === 2) {
          session.scrollback = [
            ...Array.from(
              { length: 120 },
              (_, index) => `startup-output-${index}`,
            ),
            readyScrollback,
          ]
            .join("\n")
            .split("\n")
            .slice(-120)
            .join("\n");
          outputChunks.push(readyScrollback);
        }
        return outputChunks.slice(cursor).join("");
      },
      async readLiveScrollback() {
        scrollbackReads += 1;
        return session.scrollback;
      },
    },
    ptyService: {},
    runtimeRegistry: {
      getRuntime() {
        return runtime;
      },
    },
    terminalStateService,
  });

  await service.ensureAgentReady(session, { command: "traex", args: [] });
  check(
    "trae-stale-shell-restarts-agent",
    writes.length === 1 &&
      writes[0] === "traex\r" &&
      startingTransitions === 1 &&
      idleTransitions === 1 &&
      startupOutputReads === 2 &&
      scrollbackReads === 2,
    {
      writes,
      startingTransitions,
      idleTransitions,
      startupOutputReads,
      scrollbackReads,
    },
  );
  check(
    "trae-ready-requires-live-pane-owner",
    !hasMatchingAgentReadinessOwner(null, "traex") &&
      hasMatchingAgentReadinessOwner("traex", "traex") &&
      hasMatchingAgentReadinessOwner("traecli", "traex") &&
      !hasMatchingAgentReadinessOwner("codex", "traex"),
    "TraeX readiness accepted a shell or cross-provider owner",
  );
}

function verifyOutputCursor() {
  const buffer = createScrollbackBuffer("historical-output", 64);
  const cursor = captureScrollbackBufferCursor(buffer);
  appendToScrollbackBuffer(buffer, "fresh-ready-output");
  check(
    "terminal-output-cursor-returns-only-fresh-chunks",
    readScrollbackBufferSince(buffer, cursor) === "fresh-ready-output",
    "output cursor did not isolate chunks appended after startup",
  );
  appendToScrollbackBuffer(buffer, "x".repeat(48));
  appendToScrollbackBuffer(buffer, "y".repeat(48));
  check(
    "terminal-output-cursor-rejects-trimmed-boundary",
    readScrollbackBufferSince(buffer, cursor) === null,
    "trimmed output boundary fell back to unrelated retained output",
  );
}

async function verifyPaneScopedTraeReadinessConsumer() {
  const readyScrollback = buildTraeReadyScrollback("Inspect the worker queue");
  const session = {
    id: "trae-two-pane-consumer",
    projectId: "project",
    command: "/bin/zsh",
    args: ["-l"],
    cwd: "/tmp/project",
    activeCommand: null,
    status: "running",
    runtimeKind: "tmux",
    tmuxSessionName: "runweave-trae-two-pane-consumer",
    tmuxSocketPath: "/tmp/runweave-trae-two-pane-consumer.sock",
  };
  const workerTarget = {
    sessionName: session.tmuxSessionName,
    socketPath: session.tmuxSocketPath,
    paneId: "%worker",
  };
  const mainTarget = {
    ...workerTarget,
    paneId: "%main",
  };
  const paneOutput = new Map([
    [mainTarget.paneId, readyScrollback],
    [workerTarget.paneId, ""],
  ]);
  const capturedPaneIds = [];
  const capturedInputs = [];
  const readPaneIds = [];
  let idleTransitions = 0;
  const service = new AgentTeamAgentReadinessService({
    terminalSessionManager: {},
    ptyService: {},
    runtimeRegistry: {},
    terminalStateService: {
      getCurrent() {
        return { state: "agent_starting", agent: "traex" };
      },
      setAgentIdle() {
        idleTransitions += 1;
        return { state: "agent_idle", agent: "traex" };
      },
    },
    tmuxService: {
      async readPaneMetadata(target) {
        return {
          cwd: session.cwd,
          activeCommand: target.paneId === workerTarget.paneId ? "traex" : null,
          activeCommandSource: "pane_current_command",
          paneCommand: "traex",
        };
      },
    },
    tmuxOutputWatcher: {
      async capturePaneOutputCursorAndSendInput(_session, target, input) {
        capturedPaneIds.push(target.paneId);
        capturedInputs.push(input);
        return {
          terminalSessionId: session.id,
          paneId: target.paneId,
          generation: 1,
          sequence: 0,
        };
      },
      async readPaneOutputSince(target, cursor) {
        readPaneIds.push(target.paneId);
        return target.paneId === cursor.paneId
          ? (paneOutput.get(target.paneId) ?? "")
          : null;
      },
    },
  });

  const boundary = await service.captureTraeStartupOutputBoundary(
    session,
    workerTarget,
    "traex",
  );
  const outputWithOnlyOtherPaneReady = await service.readTraeStartupOutput(
    session,
    boundary,
  );
  const acceptedOtherPaneReady = await service.isAgentUiReady(
    session,
    "traex",
    workerTarget,
    {
      publishSessionState: true,
      traeVisibleScrollback: readyScrollback,
      traeStartupOutput: outputWithOnlyOtherPaneReady,
    },
  );
  paneOutput.set(workerTarget.paneId, readyScrollback);
  const workerOutput = await service.readTraeStartupOutput(session, boundary);
  const acceptedWorkerReady = await service.isAgentUiReady(
    session,
    "traex",
    workerTarget,
    {
      publishSessionState: true,
      traeVisibleScrollback: readyScrollback,
      traeStartupOutput: workerOutput,
    },
  );

  check(
    "trae-readiness-consumer-is-pane-scoped",
    capturedPaneIds.join(",") === workerTarget.paneId &&
      capturedInputs.join(",") === "traex" &&
      readPaneIds.every((paneId) => paneId === workerTarget.paneId) &&
      !acceptedOtherPaneReady &&
      acceptedWorkerReady &&
      idleTransitions === 1,
    {
      capturedPaneIds,
      capturedInputs,
      readPaneIds,
      acceptedOtherPaneReady,
      acceptedWorkerReady,
      idleTransitions,
    },
  );
}

export async function verifyTraeReadiness(checkResult) {
  recordCheck = checkResult;
  try {
    await verifyTraeReadinessOwner();
    await verifyPaneScopedTraeReadinessConsumer();
    await verifyOrdinaryTraePanelReadyRefresh();
    verifyOutputCursor();
  } finally {
    recordCheck = null;
  }
}
