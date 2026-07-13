import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AgentTeamAgentReadinessService,
  hasMatchingAgentReadinessOwner,
} from "../backend/src/agent-team/agent-readiness.ts";
import {
  createInitialLoop,
  foldRound,
} from "../backend/src/agent-team/loop.ts";
import { normalizeAgentTeamWorkerOutbox } from "../backend/src/agent-team/outbox-resolver.ts";
import {
  buildBounceBackPrompt,
  buildWorkerRecheckPrompt,
} from "../backend/src/agent-team/prompt-builders.ts";
import {
  foldRepairGateResult,
  incrementRepairAttempts,
  resolveMaxRepairAttempts,
  resolveRepairTargets,
  reviewFindingContractErrors,
  validateCodeFixHandoff,
} from "../backend/src/agent-team/repair-loop.ts";
import { captureRepairSourceFingerprint } from "../backend/src/agent-team/repair-source-fingerprint.ts";
import { AgentTeamReviewCheckpointGit } from "../backend/src/agent-team/review-checkpoint-git.ts";
import { createAgentTeamRouter } from "../backend/src/routes/agent-team.ts";
import {
  completionSignalWorkerMismatch,
  createActiveWorkerDispatch,
  workerOutboxFreshnessMismatch,
} from "../backend/src/agent-team/service-workflow-policy.ts";
import {
  appendToScrollbackBuffer,
  captureScrollbackBufferCursor,
  createScrollbackBuffer,
  readScrollbackBufferSince,
} from "../backend/src/terminal/scrollback-buffer.ts";
import { TmuxOutputWatcher } from "../backend/src/terminal/tmux-output-watcher.ts";
import { TmuxService } from "../backend/src/terminal/tmux-service.ts";
import { ensureTmuxPanelWorkspace } from "../backend/src/terminal/application/panel-workspace.ts";
import {
  hasTraeReadyPrompt,
  hasTraeStartupFailure,
} from "../packages/shared/src/terminal-agent-readiness.ts";

const execFileAsync = promisify(execFile);
const backendRequire = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const express = backendRequire("express");
const checks = [];
const roots = [];

function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${detail}`);
  }
  checks.push(name);
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runweave-agt-review-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await writeFile(path.join(root, "app.txt"), "base\n");
  await git(root, ["add", "app.txt"]);
  await git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@runweave.local",
    "commit",
    "-m",
    "base",
  ]);
  return root;
}

async function verifyRepairSourceFingerprint() {
  const root = await createRepo();
  const baseline = await captureRepairSourceFingerprint(root);

  await mkdir(path.join(root, ".runweave"), { recursive: true });
  await writeFile(path.join(root, ".runweave", "protocol.json"), "runtime\n");
  const runtimeOnly = await captureRepairSourceFingerprint(root);
  check(
    "repair-protocol-runtime-artifacts-do-not-change-source-fingerprint",
    runtimeOnly.sha256 === baseline.sha256,
    { baseline, runtimeOnly },
  );

  await writeFile(path.join(root, "app.txt"), "changed\n");
  const trackedChange = await captureRepairSourceFingerprint(root);
  check(
    "repair-protocol-tracked-source-change-updates-fingerprint",
    trackedChange.sha256 !== baseline.sha256,
    { baseline, trackedChange },
  );

  await writeFile(path.join(root, "new-source.txt"), "untracked\n");
  const untrackedChange = await captureRepairSourceFingerprint(root);
  check(
    "repair-protocol-untracked-source-change-updates-fingerprint",
    untrackedChange.sha256 !== trackedChange.sha256,
    { trackedChange, untrackedChange },
  );
}

function buildTraeReadyScrollback(suggestion) {
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

function buildTraeMetadataScrollback() {
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

async function verifyTmuxPaneRawOutputHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runweave-tmux-pane-"));
  roots.push(root);
  const socketPath = path.join(root, "tmux.sock");
  const sessionName = "runweave-pane-output-fixture";
  const terminalSessionId = "tmux-pane-output-fixture";
  const runTmux = async (args) =>
    execFileAsync("tmux", ["-S", socketPath, ...args], { cwd: root });
  let watcher;
  try {
    await runTmux([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "100",
      "-y",
      "30",
      "/bin/zsh -f",
    ]);
    const mainPaneId = (
      await runTmux(["display-message", "-p", "-t", sessionName, "#{pane_id}"])
    ).stdout.trim();
    const workerPaneId = (
      await runTmux([
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        mainPaneId,
        "/bin/zsh -f",
      ])
    ).stdout.trim();
    const session = {
      id: terminalSessionId,
      projectId: "project",
      command: "/bin/zsh",
      args: ["-f"],
      cwd: root,
      activeCommand: "traex",
      status: "running",
      runtimeKind: "tmux",
      tmuxSessionName: sessionName,
      tmuxSocketPath: socketPath,
    };
    const tmuxService = new TmuxService({ socketPath });
    watcher = new TmuxOutputWatcher({
      outputDir: path.join(root, "output"),
      terminalSessionManager: {
        getSession(id) {
          return id === terminalSessionId ? session : null;
        },
      },
      tmuxService,
      pollIntervalMs: 60_000,
    });
    const mainTarget = { sessionName, socketPath, paneId: mainPaneId };
    const workerTarget = { sessionName, socketPath, paneId: workerPaneId };
    const mainCursor = await watcher.capturePaneOutputCursorAndSendInput(
      session,
      mainTarget,
      ":",
    );
    const workerCursor = await watcher.capturePaneOutputCursorAndSendInput(
      session,
      workerTarget,
      ":",
    );
    check(
      "tmux-pane-output-cursors-created",
      mainCursor?.paneId === mainPaneId &&
        workerCursor?.paneId === workerPaneId,
      { mainCursor, workerCursor },
    );

    await sendTmuxFixtureCommand(
      runTmux,
      mainPaneId,
      "printf 'TRAE CLI Next\\nmodel: main\\ndirectory: /tmp/project\\npermissions: normal\\n❯ Other pane suggestion\\n'",
    );
    await waitForFixtureOutput();
    const mainOutput = await watcher.readPaneOutputSince(
      mainTarget,
      mainCursor,
    );
    const workerOutputBeforeLaunch = await watcher.readPaneOutputSince(
      workerTarget,
      workerCursor,
    );
    const mismatchedOutput = await watcher.readPaneOutputSince(
      mainTarget,
      workerCursor,
    );
    check(
      "tmux-other-pane-ready-is-isolated",
      mainOutput?.includes("TRAE CLI Next") === true &&
        workerOutputBeforeLaunch?.includes("TRAE CLI Next") === false &&
        mismatchedOutput === null,
      { mainOutput, workerOutputBeforeLaunch, mismatchedOutput },
    );

    await sendTmuxFixtureCommand(
      runTmux,
      workerPaneId,
      "printf 'MAIN_SCREEN_BEFORE_ALT\\n\\033[?1049hTRAE CLI Next\\nmodel: worker\\ndirectory: /tmp/project\\npermissions: normal\\n❯ Dynamic worker suggestion\\n'",
    );
    await waitForFixtureOutput();
    const workerRawOutput = await watcher.readPaneOutputSince(
      workerTarget,
      workerCursor,
    );
    const workerCapture = (
      await runTmux(["capture-pane", "-p", "-S", "-5000", "-t", workerPaneId])
    ).stdout;
    check(
      "tmux-pane-raw-stream-survives-alternate-screen",
      workerRawOutput?.includes("MAIN_SCREEN_BEFORE_ALT") === true &&
        workerRawOutput.includes("TRAE CLI Next") &&
        hasTraeReadyPrompt(workerRawOutput) &&
        !workerCapture.includes("MAIN_SCREEN_BEFORE_ALT") &&
        workerCapture.includes("TRAE CLI Next"),
      { workerRawOutput, workerCapture },
    );

    const workerKey = `${terminalSessionId}\0${workerPaneId}`;
    const watchedWorker = watcher.watchedPanes.get(workerKey);
    const captureRaceAttempts = [];
    const captureRaceBacklog = "b".repeat(900 * 1024);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const marker = `CAPTURE_RACE_MARKER_${attempt}`;
      await appendFile(watchedWorker.filePath, captureRaceBacklog);
      const sequenceBeforeCapture = watchedWorker.outputBuffer.nextSequence;
      let captureCompleted = false;
      const capturePromise = watcher
        .capturePaneOutputCursorAndSendInput(session, workerTarget, ":")
        .then((cursor) => {
          captureCompleted = true;
          return cursor;
        });
      await waitForFixtureCondition(
        () => watchedWorker.outputBuffer.nextSequence > sequenceBeforeCapture,
        "capture read did not start",
      );
      await appendFile(watchedWorker.filePath, marker);
      const appendBeforeCapture = !captureCompleted;
      const cursor = await capturePromise;
      const outputAfterCursor = cursor
        ? await watcher.readPaneOutputSince(workerTarget, cursor)
        : null;
      captureRaceAttempts.push({
        appendBeforeCapture,
        leaked: outputAfterCursor?.includes(marker) === true,
      });
    }
    const captureRaceResult = {
      maxTransportBytes: 1024 * 1024,
      backlogBytes: 900 * 1024,
      attempts: captureRaceAttempts,
    };
    process.stdout.write(
      `${JSON.stringify({
        fixture: "tmux-pane-capture-concurrent-append",
        ...captureRaceResult,
      })}\n`,
    );
    check(
      "tmux-pane-capture-excludes-concurrent-precompletion-output",
      captureRaceAttempts.every(
        (attempt) => attempt.appendBeforeCapture && !attempt.leaked,
      ),
      JSON.stringify(captureRaceResult),
    );

    const postBoundaryOutput = "BOUNDARY_AND_SEND_OUTPUT";
    const atomicCursor = await watcher.capturePaneOutputCursorAndSendInput(
      session,
      workerTarget,
      `printf '${postBoundaryOutput}'`,
    );
    const postBoundaryBufferedAtReturn = watchedWorker.outputBuffer.chunks
      .map((chunk) => chunk.text)
      .join("")
      .includes(postBoundaryOutput);
    const atomicOutput = atomicCursor
      ? await watcher.readPaneOutputSince(workerTarget, atomicCursor)
      : null;
    const atomicCapture = (
      await runTmux(["capture-pane", "-p", "-S", "-200", "-t", workerPaneId])
    ).stdout;
    const boundaryAndSendResult = {
      postBoundaryBufferedAtReturn,
      postBoundaryReturnedAfterCursor:
        atomicOutput?.includes(postBoundaryOutput) === true,
      markerReturnedAfterCursor:
        atomicOutput?.includes("runweave-pane-boundary=") === true,
      markerVisible: atomicCapture.includes("runweave-pane-boundary="),
    };
    process.stdout.write(
      `${JSON.stringify({
        fixture: "tmux-pane-boundary-and-send",
        ...boundaryAndSendResult,
      })}\n`,
    );
    check(
      "tmux-boundary-and-send-preserves-precompletion-start-output",
      boundaryAndSendResult.postBoundaryBufferedAtReturn &&
        boundaryAndSendResult.postBoundaryReturnedAfterCursor &&
        !boundaryAndSendResult.markerReturnedAfterCursor &&
        !boundaryAndSendResult.markerVisible,
      boundaryAndSendResult,
    );

    const resetCursor = await watcher.capturePaneOutputCursorAndSendInput(
      session,
      workerTarget,
      ":",
    );
    check(
      "tmux-pane-reset-cursor-created",
      Boolean(watchedWorker && resetCursor),
      { watchedWorker: Boolean(watchedWorker), resetCursor },
    );
    await writeFile(
      watchedWorker.filePath,
      buildTraeReadyScrollback("Fresh output after transport reset"),
    );
    watchedWorker.offset = 1024 * 1024;
    const resetOutput = await watcher.readPaneOutputSince(
      workerTarget,
      resetCursor,
    );
    check(
      "tmux-pane-generation-is-rechecked-after-poll",
      resetOutput === null &&
        watchedWorker.generation !== resetCursor.generation,
      {
        resetOutput,
        cursorGeneration: resetCursor.generation,
        watcherGeneration: watchedWorker.generation,
      },
    );

    await rm(watchedWorker.filePath, { force: true });
    const unavailableCursor = await watcher.capturePaneOutputCursorAndSendInput(
      session,
      workerTarget,
      ":",
    );
    check(
      "tmux-pane-capture-fails-closed-on-transport-error",
      unavailableCursor === null,
      { unavailableCursor },
    );

    await runTmux(["kill-pane", "-t", workerPaneId]);
    await watcher.pollAll();
    check(
      "tmux-dead-pane-watcher-is-removed",
      watcher.watchedPanes.size === 1 && !watcher.watchedPanes.has(workerKey),
      Array.from(watcher.watchedPanes.keys()),
    );
    await watcher.unwatchPane(terminalSessionId, mainPaneId);
    check(
      "tmux-panel-delete-can-unwatch-one-pane",
      watcher.watchedPanes.size === 0,
      Array.from(watcher.watchedPanes.keys()),
    );
  } finally {
    await watcher?.dispose();
    await runTmux(["kill-server"]).catch(() => undefined);
  }
}

async function sendTmuxFixtureCommand(runTmux, paneId, command) {
  await runTmux(["send-keys", "-t", paneId, "-l", "--", command]);
  await runTmux(["send-keys", "-t", paneId, "Enter"]);
}

function waitForFixtureOutput() {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

async function waitForFixtureCondition(condition, failureMessage) {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(failureMessage);
}

async function verifyTraeStartupFailureBoundary() {
  const failure = "zsh: command not found: traex";
  const session = {
    id: "trae-stale-failure",
    projectId: "project",
    command: "/bin/zsh",
    args: ["-l"],
    cwd: "/tmp/project",
    activeCommand: null,
    scrollback: `${failure}\n➜  project git:(main) ✗`,
    status: "running",
    runtimeKind: "pty",
    panelSplitEnabled: false,
  };
  const outputChunks = [failure];
  let startupOutputReads = 0;
  let idleTransitions = 0;
  const service = new AgentTeamAgentReadinessService({
    terminalSessionManager: {
      async captureOutputCursor() {
        return outputChunks.length;
      },
      readOutputSince(_terminalSessionId, cursor) {
        startupOutputReads += 1;
        if (startupOutputReads === 2) {
          outputChunks.push(failure);
          session.scrollback = failure;
        }
        return outputChunks.slice(cursor).join("");
      },
      async readLiveScrollback() {
        return session.scrollback;
      },
    },
    ptyService: {},
    runtimeRegistry: {
      getRuntime() {
        return {
          write() {
            session.activeCommand = "traex";
            outputChunks.push("traex\n");
          },
        };
      },
    },
    terminalStateService: {
      getCurrent() {
        return session.activeCommand
          ? { state: "agent_starting", agent: "traex" }
          : { state: "shell_idle", agent: null };
      },
      setAgentStarting() {
        return { state: "agent_starting", agent: "traex" };
      },
      setAgentIdle() {
        idleTransitions += 1;
        return { state: "agent_idle", agent: "traex" };
      },
    },
  });

  let failureError = null;
  try {
    await service.ensureAgentReady(session, { command: "traex", args: [] });
  } catch (error) {
    failureError = error;
  }
  check(
    "trae-startup-output-cursor-detects-fresh-failure",
    failureError?.details?.reason === "startup_failure" &&
      startupOutputReads === 2 &&
      idleTransitions === 0,
    {
      failureReason: failureError?.details?.reason ?? null,
      startupOutputReads,
      idleTransitions,
    },
  );
}

function buildRepairEvidence(label) {
  return {
    type: "command",
    label,
    summary: `${label} evidence`,
    ref: `fixture:${label}`,
  };
}

function buildRepairRun() {
  const now = "2026-07-14T00:00:00.000Z";
  return {
    runId: "atr_repair_fixture",
    projectId: "project",
    terminalSessionId: "repair-session",
    phase: "executing",
    status: "running",
    options: {
      autoApproveSplit: true,
      reviewCheckpointMode: "disabled",
      maxRepairAttempts: 3,
    },
    terminal: { command: "codex", args: [], cwd: null },
    task: "repair fixture",
    verification: null,
    reviewCheckpoint: null,
    activeWorkerRole: "code",
    activeWorkerDispatch: null,
    clarify: [],
    proposal: null,
    workers: [
      {
        id: "code-worker",
        role: "code",
        intent: "fix",
        panelId: "code-panel",
        tmuxPaneId: "%1",
        frozen: false,
      },
      {
        id: "review-worker",
        role: "code_review",
        intent: "review",
        panelId: "review-panel",
        tmuxPaneId: "%2",
        frozen: true,
      },
      {
        id: "behavior-worker",
        role: "behavior_verify",
        intent: "verify",
        panelId: "behavior-panel",
        tmuxPaneId: "%3",
        frozen: true,
      },
    ],
    acceptance: [
      {
        caseId: "CASE-RUNTIME-001",
        text: "真实 runtime invariant",
        status: "fail",
        consecutiveFail: 2,
        evidence: [buildRepairEvidence("runtime-fail")],
        bouncedToPanelId: "code-panel",
      },
      {
        caseId: "case_2",
        text: "Code Review 未发现阻断性问题（P0/P1）",
        status: "fail",
        consecutiveFail: 1,
        evidence: [buildRepairEvidence("review-fail")],
        bouncedToPanelId: "code-panel",
      },
    ],
    loop: createInitialLoop(3),
    humanNotes: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}

function buildFixVerification(cycle, overrides = {}) {
  const runtime = cycle.verificationMode === "runtime";
  const structuralEvidence = (cycle.sourceEvidenceRefs ?? []).map((ref) => ({
    ...buildRepairEvidence("review-harness"),
    ref,
  }));
  return {
    repairKey: cycle.repairKey,
    invariant: cycle.invariant,
    reproduction: {
      mode: runtime ? "real_product" : "review_harness",
      status: runtime ? "reproduced" : "confirmed",
      ...(runtime
        ? {
            scenarioId: "repair-runtime",
            validationSessionId: "dvs-repair",
          }
        : {}),
      evidence: runtime
        ? [buildRepairEvidence("before")]
        : structuralEvidence.length > 0
          ? structuralEvidence
          : [buildRepairEvidence("before")],
    },
    verification: {
      status: "pass",
      sameScenario: true,
      evidence: runtime
        ? [buildRepairEvidence("after")]
        : structuralEvidence.length > 0
          ? structuralEvidence
          : [buildRepairEvidence("after")],
    },
    impactedChecks: [
      {
        label: "affected regression",
        dimension: "regression",
        status: "pass",
        summary: "affected regression passed",
        evidence: [buildRepairEvidence("regression")],
      },
    ],
    ...overrides,
  };
}

function normalizeRepairOutbox(run, fixVerifications) {
  return normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    panelId: "code-panel",
    tmuxPaneId: "%1",
    projectId: run.projectId,
    runId: run.runId,
    role: "code",
    status: "completed",
    summary: "repair complete",
    error: null,
    finishedAt: "2026-07-14T00:01:00.000Z",
    fixVerifications,
  });
}

function verifyEvidenceGatedRepairLoop() {
  const run = buildRepairRun();
  const behaviorOutbox = normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    panelId: "behavior-panel",
    role: "behavior_verify",
    status: "completed",
    summary: "runtime failed",
    error: null,
    finishedAt: "2026-07-14T00:00:10.000Z",
    acceptanceResults: [
      {
        caseId: "CASE-RUNTIME-001",
        status: "fail",
        summary: "runtime still fails",
        evidence: [buildRepairEvidence("runtime-fail")],
      },
    ],
  });
  const behaviorTargets = resolveRepairTargets(
    run,
    behaviorOutbox,
    behaviorOutbox.acceptanceResults,
  );
  const behaviorFold = foldRepairGateResult({
    loop: run.loop,
    completedRole: "behavior_verify",
    acceptanceResults: behaviorOutbox.acceptanceResults,
    targets: behaviorTargets,
    round: 1,
  });
  const runtimeCycle = behaviorFold.loop.repairCycles[0];
  const runtimeRun = {
    ...run,
    loop: behaviorFold.loop,
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [runtimeCycle.repairKey] },
    ),
  };
  const runtimePrompt = buildBounceBackPrompt({
    run: runtimeRun,
    failedCases: [run.acceptance[0]],
    repairCycles: [runtimeCycle],
  });
  check(
    "repair-runtime-prompt-requires-real-reproduction",
    runtimePrompt.includes("$toolkit:reproduce-before-fix") &&
      runtimePrompt.includes("同一 scenarioId") &&
      runtimePrompt.includes("任一必跑项失败立即停止"),
    runtimePrompt,
  );
  const reviewRecheckPrompt = buildWorkerRecheckPrompt({
    run: runtimeRun,
    worker: run.workers[1],
    cases: [run.acceptance[1]],
    triggerSummary: "code handoff",
  });
  check(
    "repair-review-recheck-does-not-claim-fix-completion",
    reviewRecheckPrompt.includes("Code Agent 已提交本轮代码结果，请独立审查") &&
      !reviewRecheckPrompt.includes("已完成修复"),
    reviewRecheckPrompt,
  );
  const behaviorRecheckPrompt = buildWorkerRecheckPrompt({
    run: runtimeRun,
    worker: run.workers[2],
    cases: [run.acceptance[0]],
    triggerSummary: "incremental review passed",
  });
  check(
    "repair-behavior-recheck-distinguishes-review-from-behavior-pass",
    behaviorRecheckPrompt.includes("以下行为 case 尚未验证或需要复验") &&
      behaviorRecheckPrompt.includes("review pass 不代表 behavior pass") &&
      behaviorRecheckPrompt.includes("上游 review 摘要") &&
      !behaviorRecheckPrompt.includes("本轮修复摘要") &&
      !behaviorRecheckPrompt.includes("已完成修复"),
    behaviorRecheckPrompt,
  );
  const validRuntimeOutbox = normalizeRepairOutbox(runtimeRun, [
    buildFixVerification(runtimeCycle),
  ]);
  check(
    "repair-runtime-before-after-handoff-valid",
    validateCodeFixHandoff(runtimeRun, validRuntimeOutbox).status === "valid",
    validRuntimeOutbox,
  );
  check(
    "repair-missing-handoff-rejected",
    validateCodeFixHandoff(runtimeRun, normalizeRepairOutbox(runtimeRun, []))
      .status === "invalid",
    "missing fixVerifications accepted",
  );
  const blockedOutbox = normalizeRepairOutbox(runtimeRun, [
    buildFixVerification(runtimeCycle, {
      reproduction: {
        mode: "real_product",
        status: "blocked",
        scenarioId: "repair-runtime",
        validationSessionId: "dvs-repair",
        evidence: [buildRepairEvidence("blocked")],
      },
    }),
  ]);
  check(
    "repair-blocked-handoff-stops",
    validateCodeFixHandoff(runtimeRun, blockedOutbox).status === "blocked",
    blockedOutbox,
  );
  const failedImpactOutbox = normalizeRepairOutbox(runtimeRun, [
    buildFixVerification(runtimeCycle, {
      impactedChecks: [
        {
          label: "temporal failure",
          dimension: "temporal",
          status: "fail",
          summary: "stop immediately",
          evidence: [buildRepairEvidence("temporal-fail")],
        },
      ],
    }),
  ]);
  check(
    "repair-failed-impacted-check-blocks",
    validateCodeFixHandoff(runtimeRun, failedImpactOutbox).status === "blocked",
    failedImpactOutbox,
  );

  const reviewOutbox = normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    panelId: "review-panel",
    role: "code_review",
    status: "completed",
    summary: "P1",
    error: null,
    finishedAt: "2026-07-14T00:00:20.000Z",
    remainingFindings: [
      {
        severity: "P1",
        status: "open",
        title: "checkpoint ownership",
        summary: "backend owns checkpoint index",
        invariantKey: "checkpoint.index-ownership",
        verificationMode: "structural",
        ref: "review:checkpoint",
      },
    ],
    acceptanceResults: [
      {
        caseId: "case_2",
        status: "fail",
        summary: "P1",
        evidence: [buildRepairEvidence("review-fail")],
      },
    ],
  });
  check(
    "repair-review-finding-contract-valid",
    reviewFindingContractErrors(reviewOutbox, reviewOutbox.acceptanceResults)
      .length === 0,
    reviewOutbox,
  );
  const reviewTargets = resolveRepairTargets(
    run,
    reviewOutbox,
    reviewOutbox.acceptanceResults,
  );
  const reviewFold = foldRepairGateResult({
    loop: behaviorFold.loop,
    completedRole: "code_review",
    acceptanceResults: reviewOutbox.acceptanceResults,
    targets: reviewTargets,
    round: 2,
  });
  const structuralCycle = reviewFold.loop.repairCycles.find(
    (cycle) => cycle.sourceRole === "code_review",
  );
  const structuralRun = {
    ...run,
    loop: reviewFold.loop,
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [structuralCycle.repairKey] },
    ),
  };
  const structuralPrompt = buildBounceBackPrompt({
    run: structuralRun,
    failedCases: [run.acceptance[1]],
    repairCycles: [structuralCycle],
  });
  check(
    "repair-structural-uses-original-harness",
    structuralPrompt.includes("原样复跑 reviewer evidence") &&
      !structuralPrompt.includes("Codex worker 在修改源码前显式调用"),
    structuralPrompt,
  );
  check(
    "repair-structural-handoff-valid",
    validateCodeFixHandoff(
      structuralRun,
      normalizeRepairOutbox(structuralRun, [
        buildFixVerification(structuralCycle),
      ]),
    ).status === "valid",
    structuralCycle,
  );
  check(
    "repair-structural-rejects-unrelated-harness",
    validateCodeFixHandoff(
      structuralRun,
      normalizeRepairOutbox(structuralRun, [
        buildFixVerification(structuralCycle, {
          reproduction: {
            mode: "review_harness",
            status: "confirmed",
            evidence: [buildRepairEvidence("unrelated-before")],
          },
          verification: {
            status: "pass",
            sameScenario: true,
            evidence: [buildRepairEvidence("unrelated-after")],
          },
        }),
      ]),
    ).status === "invalid",
    structuralCycle,
  );

  const invalidReviewOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    remainingFindings: [
      {
        severity: "P1",
        status: "open",
        title: "missing contract",
        summary: "missing stable identity",
      },
    ],
  });
  check(
    "repair-new-review-finding-requires-stable-key",
    reviewFindingContractErrors(
      invalidReviewOutbox,
      invalidReviewOutbox.acceptanceResults,
    ).length === 2,
    invalidReviewOutbox,
  );

  const secondTitleOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    remainingFindings: [
      {
        ...reviewOutbox.remainingFindings[0],
        title: "new symptom, same invariant",
        summary: "backend still owns checkpoint index at a new call site",
      },
      {
        severity: "P1",
        status: "open",
        title: "readiness boundary",
        summary: "readiness must use an event boundary",
        invariantKey: "readiness.event-boundary",
        verificationMode: "runtime",
      },
    ],
  });
  const isolatedTargets = resolveRepairTargets(
    run,
    secondTitleOutbox,
    secondTitleOutbox.acceptanceResults,
  );
  check(
    "repair-review-invariant-keys-isolate-generic-case",
    isolatedTargets
      .map((target) => target.repairKey)
      .sort()
      .join(",") ===
      "code_review:checkpoint.index-ownership,code_review:readiness.event-boundary",
    isolatedTargets,
  );

  let budgetLoop = behaviorFold.loop;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    budgetLoop = incrementRepairAttempts(budgetLoop, [runtimeCycle.repairKey]);
  }
  const budgetRun = { ...run, loop: budgetLoop };
  const diffFold = foldRound(budgetRun, { hadDiff: true });
  const exhausted = foldRepairGateResult({
    loop: diffFold.loop,
    completedRole: "behavior_verify",
    acceptanceResults: behaviorOutbox.acceptanceResults,
    targets: behaviorTargets,
    round: 3,
  });
  check(
    "repair-diff-does-not-reset-budget",
    exhausted.loop.repairCycles[0]?.attempts === 3 &&
      exhausted.exhausted[0]?.repairKey === runtimeCycle.repairKey,
    exhausted,
  );
  check(
    "repair-budget-default-and-bounds",
    resolveMaxRepairAttempts(undefined) === 3 &&
      resolveMaxRepairAttempts(1) === 1 &&
      resolveMaxRepairAttempts(5) === 5 &&
      resolveMaxRepairAttempts(0) === 3 &&
      resolveMaxRepairAttempts(6) === 3,
    "repair budget bounds failed",
  );

  const secondAttemptCycle = { ...runtimeCycle, attempts: 1 };
  const secondAttemptRun = {
    ...runtimeRun,
    loop: { ...runtimeRun.loop, repairCycles: [secondAttemptCycle] },
  };
  check(
    "repair-second-attempt-requires-strategy-assessment",
    validateCodeFixHandoff(
      secondAttemptRun,
      normalizeRepairOutbox(secondAttemptRun, [
        buildFixVerification(secondAttemptCycle),
      ]),
    ).status === "invalid" &&
      validateCodeFixHandoff(
        secondAttemptRun,
        normalizeRepairOutbox(secondAttemptRun, [
          buildFixVerification(secondAttemptCycle, {
            strategyAssessment:
              "上一轮缺少事件边界，本轮调整状态所有权而非增加文案分支。",
          }),
        ]),
      ).status === "valid",
    secondAttemptCycle,
  );

  const multiRun = {
    ...run,
    loop: {
      ...reviewFold.loop,
      repairCycles: [runtimeCycle, structuralCycle],
    },
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [runtimeCycle.repairKey, structuralCycle.repairKey] },
    ),
  };
  check(
    "repair-multi-finding-requires-complete-handoff",
    validateCodeFixHandoff(
      multiRun,
      normalizeRepairOutbox(multiRun, [buildFixVerification(runtimeCycle)]),
    ).status === "invalid" &&
      validateCodeFixHandoff(
        multiRun,
        normalizeRepairOutbox(multiRun, [
          buildFixVerification(runtimeCycle),
          buildFixVerification(structuralCycle),
        ]),
      ).status === "valid",
    multiRun.activeWorkerDispatch,
  );
  check(
    "repair-stale-outbox-cannot-double-count",
    workerOutboxFreshnessMismatch(
      createActiveWorkerDispatch(
        run.workers[0],
        run.updatedAt,
        200,
        run.loop.round,
      ),
      200,
    ) === "outbox_not_newer_than_dispatch_baseline",
    "stale outbox accepted",
  );
  check(
    "repair-accepted-handoff-restart-state-is-idempotent",
    incrementRepairAttempts(runtimeRun.loop, [runtimeCycle.repairKey])
      .repairCycles[0]?.attempts === 1 &&
      completionSignalWorkerMismatch(
        {
          kind: "completion",
          payload: { panelId: "code-panel", tmuxPaneId: "%1" },
        },
        run.workers[1],
      ) === "signal_panel_mismatch",
    "a repeated code completion could match the persisted reviewer dispatch",
  );
  check(
    "repair-legacy-outbox-remains-readable",
    Boolean(
      normalizeAgentTeamWorkerOutbox({
        sessionId: "legacy",
        role: "code",
        status: "completed",
        summary: "legacy",
        error: null,
        finishedAt: "2026-07-14T00:00:00.000Z",
      }),
    ),
    "legacy outbox rejected",
  );
  check(
    "repair-counters-remain-independent",
    diffFold.loop.noProgressCount === 0 &&
      diffFold.loop.repairCycles[0]?.attempts === 3 &&
      run.acceptance[0].recheckAttempt === undefined,
    diffFold.loop,
  );
}

async function verifyRepairBudgetRoute() {
  const acceptedOptions = [];
  const service = {
    async startRun(input) {
      acceptedOptions.push(input.options ?? {});
      return { ok: true, options: input.options ?? {} };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/agent-team", createAgentTeamRouter(service));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/agent-team/runs`;
    const post = (maxRepairAttempts) =>
      fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project",
          terminalSessionId: "terminal",
          task: "fixture",
          options: maxRepairAttempts === undefined ? {} : { maxRepairAttempts },
        }),
      });
    const invalidLow = await post(0);
    const invalidHigh = await post(6);
    const validLow = await post(1);
    const validHigh = await post(5);
    const validDefault = await post(undefined);
    check(
      "repair-budget-route-enforces-one-to-five",
      invalidLow.status === 400 &&
        invalidHigh.status === 400 &&
        validLow.ok &&
        validHigh.ok &&
        validDefault.ok &&
        acceptedOptions.length === 3 &&
        acceptedOptions[0]?.maxRepairAttempts === 1 &&
        acceptedOptions[1]?.maxRepairAttempts === 5 &&
        acceptedOptions[2]?.maxRepairAttempts === undefined,
      {
        statuses: [
          invalidLow.status,
          invalidHigh.status,
          validLow.status,
          validHigh.status,
          validDefault.status,
        ],
        acceptedOptions,
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function main() {
  const traeReadyScrollback = buildTraeReadyScrollback(
    "Summarize recent commits",
  );
  check(
    "trae-banner-only-is-not-ready",
    !hasTraeReadyPrompt("TRAE CLI Next"),
    "TraeX banner without metadata and input UI was accepted",
  );
  check(
    "trae-metadata-without-input-is-not-ready",
    !hasTraeReadyPrompt(buildTraeMetadataScrollback()),
    "TraeX metadata without input prompt/footer was accepted",
  );
  check(
    "trae-dynamic-summarize-suggestion-is-ready",
    hasTraeReadyPrompt(traeReadyScrollback),
    "real TraeX dynamic Summarize suggestion was not recognized",
  );
  check(
    "trae-arbitrary-dynamic-suggestion-is-ready",
    hasTraeReadyPrompt(
      buildTraeReadyScrollback("Map dependency ownership boundaries"),
    ),
    "TraeX ready detection still depends on a suggestion allowlist",
  );
  check(
    "trae-ready-does-not-require-divider-or-footer-decoration",
    hasTraeReadyPrompt(
      `${buildTraeMetadataScrollback()}\n❯ Suggest another safe task`,
    ) &&
      hasTraeReadyPrompt(
        `${buildTraeMetadataScrollback()}\n··\n❯ Different prompt chrome\naccess: full`,
      ),
    "TraeX ready detection still depends on divider glyphs, width, or permission footer decoration",
  );
  check(
    "trae-ready-suggestion-requires-banner",
    !hasTraeReadyPrompt("❯ Summarize recent commits\n───\nmodel ▰ mode"),
    "suggestion text without the TraeX UI banner was accepted",
  );
  check(
    "trae-startup-failure-without-banner",
    hasTraeStartupFailure("zsh: command not found: traex"),
    "startup failure before the TraeX banner was ignored",
  );
  const staleReadyThenFailure = `${traeReadyScrollback}\nzsh: command not found: traex`;
  check(
    "trae-stale-ready-does-not-mask-failure",
    !hasTraeReadyPrompt(staleReadyThenFailure) &&
      hasTraeStartupFailure(staleReadyThenFailure),
    "ready output masked a later startup failure",
  );
  const nextStartupWithoutReady = `${staleReadyThenFailure}\nTRAE CLI Next\nModel: default`;
  check(
    "trae-new-startup-epoch-requires-ready-marker",
    !hasTraeReadyPrompt(nextStartupWithoutReady) &&
      !hasTraeStartupFailure(nextStartupWithoutReady),
    "a new startup banner reused a marker or failure from an older epoch",
  );
  check(
    "trae-interactive-prompt-blocks-ready",
    !hasTraeReadyPrompt(`${traeReadyScrollback}\nSelect an option`) &&
      !hasTraeStartupFailure(`${traeReadyScrollback}\nSelect an option`),
    "an interactive prompt after ready did not block dispatch",
  );
  await verifyTraeReadinessOwner();
  await verifyTraeStartupFailureBoundary();
  await verifyPaneScopedTraeReadinessConsumer();
  await verifyTmuxPaneRawOutputHarness();
  await verifyOrdinaryTraePanelReadyRefresh();
  verifyOutputCursor();
  verifyEvidenceGatedRepairLoop();
  await verifyRepairSourceFingerprint();
  await verifyRepairBudgetRoute();

  const service = new AgentTeamReviewCheckpointGit();
  const root = await createRepo();
  await mkdir(path.join(root, ".runweave", "outbox"), { recursive: true });
  await writeFile(
    path.join(root, ".runweave", "outbox", "runtime.json"),
    "{}\n",
  );
  const preflight = await service.preflight(root);
  check(
    "preflight-allows-runtime-artifacts",
    preflight.originalBranch === "main",
    preflight,
  );
  await service.createRunBranch(root, "runweave/agt-fixture");
  const state = {
    mode: "local_commit",
    repoRoot: root,
    originalBranch: preflight.originalBranch,
    branch: "runweave/agt-fixture",
    taskBaseCommit: preflight.taskBaseCommit,
    lastReviewedCommit: preflight.taskBaseCommit,
    pendingReview: null,
    checkpoints: [],
    finalReviewedCommit: null,
  };

  await writeFile(path.join(root, "app.txt"), "base\nround-one\n");
  await writeFile(path.join(root, "new.txt"), "new\n");
  await mkdir(path.join(root, "docs", "review"), { recursive: true });
  await writeFile(path.join(root, "docs", "review", "round.md"), "review\n");
  const target1 = await service.prepareReviewTarget({
    state,
    scope: "full",
    planSha256: "plan-one",
    testCaseSha256: "cases-one",
  });
  check(
    "full-target-paths",
    target1.changedPaths.join(",") === "app.txt,new.txt",
    target1.changedPaths,
  );
  const checkpoint1 = await service.commitReviewedTarget({
    runId: "atr_fixture",
    reviewRound: 2,
    reviewerPanelId: "review-panel",
    state,
    target: target1,
  });
  check(
    "checkpoint-tree-matches",
    checkpoint1.tree === target1.targetTree,
    checkpoint1,
  );
  check(
    "review-artifact-excluded",
    (
      await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    ).includes("docs/review/round.md"),
    "review artifact should remain outside checkpoint",
  );
  check(
    "runtime-artifact-excluded",
    (
      await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    ).includes(".runweave/outbox/runtime.json"),
    "runtime artifact should remain outside checkpoint",
  );

  const recovered = await service.recoverCommittedCheckpoint({
    runId: "atr_fixture",
    reviewRound: 2,
    reviewerPanelId: "review-panel",
    state,
    target: target1,
  });
  check("commit-recovery", recovered?.commit === checkpoint1.commit, recovered);

  const state2 = {
    ...state,
    lastReviewedCommit: checkpoint1.commit,
    checkpoints: [checkpoint1],
  };
  await service.assertCheckpointHead(state2);
  check(
    "checkpoint-head-allows-review-artifact",
    true,
    "review artifact blocked checkpoint head",
  );
  await writeFile(path.join(root, "app.txt"), "base\nround-one\nround-two\n");
  const target2 = await service.prepareReviewTarget({
    state: state2,
    scope: "incremental",
    planSha256: "plan-one",
    testCaseSha256: "cases-one",
  });
  check(
    "incremental-base",
    target2.baseCommit === checkpoint1.commit &&
      target2.changedPaths.join(",") === "app.txt",
    target2,
  );
  await writeFile(
    path.join(root, "app.txt"),
    "base\nround-one\nround-two\npost-review-drift\n",
  );
  let driftRejected = false;
  try {
    await service.assertReviewTargetUnchanged(state2, target2);
  } catch {
    driftRejected = true;
  }
  check("stale-review-target-rejected", driftRejected, "code drift accepted");
  await writeFile(path.join(root, "app.txt"), "base\nround-one\nround-two\n");
  const checkpoint2 = await service.commitReviewedTarget({
    runId: "atr_fixture",
    reviewRound: 4,
    reviewerPanelId: "review-panel",
    state: state2,
    target: target2,
  });
  check(
    "checkpoint-parent-chain",
    checkpoint2.parentCommit === checkpoint1.commit,
    checkpoint2,
  );
  const state3 = {
    ...state2,
    lastReviewedCommit: checkpoint2.commit,
    checkpoints: [checkpoint1, checkpoint2],
  };
  const finalTarget = await service.prepareReviewTarget({
    state: state3,
    scope: "final",
    planSha256: "plan-one",
    testCaseSha256: "cases-one",
  });
  check(
    "final-target-covers-task-base",
    finalTarget.baseCommit === preflight.taskBaseCommit &&
      finalTarget.targetTree === checkpoint2.tree &&
      finalTarget.changedPaths.join(",") === "app.txt,new.txt",
    finalTarget,
  );
  await service.assertReviewTargetUnchanged(state3, finalTarget);
  check("final-target-unchanged", true, "final target rejected");

  const emptyRoot = await createRepo();
  const emptyPreflight = await service.preflight(emptyRoot);
  await service.createRunBranch(emptyRoot, "runweave/agt-empty");
  let emptyRejected = false;
  try {
    await service.prepareReviewTarget({
      state: {
        mode: "local_commit",
        repoRoot: emptyRoot,
        originalBranch: "main",
        branch: "runweave/agt-empty",
        taskBaseCommit: emptyPreflight.taskBaseCommit,
        lastReviewedCommit: emptyPreflight.taskBaseCommit,
        pendingReview: null,
        checkpoints: [],
        finalReviewedCommit: null,
      },
      scope: "full",
      planSha256: null,
      testCaseSha256: null,
    });
  } catch {
    emptyRejected = true;
  }
  check("empty-target-rejected", emptyRejected, "empty checkpoint accepted");

  const branchDriftRoot = await createRepo();
  const branchDriftPreflight = await service.preflight(branchDriftRoot);
  await service.createRunBranch(branchDriftRoot, "runweave/agt-branch-drift");
  await git(branchDriftRoot, ["switch", "main"]);
  let branchDriftRejected = false;
  try {
    await service.prepareReviewTarget({
      state: {
        mode: "local_commit",
        repoRoot: branchDriftRoot,
        originalBranch: "main",
        branch: "runweave/agt-branch-drift",
        taskBaseCommit: branchDriftPreflight.taskBaseCommit,
        lastReviewedCommit: branchDriftPreflight.taskBaseCommit,
        pendingReview: null,
        checkpoints: [],
        finalReviewedCommit: null,
      },
      scope: "full",
      planSha256: null,
      testCaseSha256: null,
    });
  } catch {
    branchDriftRejected = true;
  }
  check(
    "branch-drift-rejected",
    branchDriftRejected,
    "external branch switch accepted",
  );

  const dirtyRoot = await createRepo();
  await writeFile(path.join(dirtyRoot, "dirty.txt"), "dirty\n");
  let dirtyRejected = false;
  try {
    await service.preflight(dirtyRoot);
  } catch {
    dirtyRejected = true;
  }
  check("dirty-preflight-rejected", dirtyRejected, "dirty repo accepted");

  const secretRoot = await createRepo();
  const secretPreflight = await service.preflight(secretRoot);
  await service.createRunBranch(secretRoot, "runweave/agt-secret");
  await writeFile(path.join(secretRoot, ".env.local"), "TOKEN=secret\n");
  let secretRejected = false;
  try {
    await service.prepareReviewTarget({
      state: {
        mode: "local_commit",
        repoRoot: secretRoot,
        originalBranch: "main",
        branch: "runweave/agt-secret",
        taskBaseCommit: secretPreflight.taskBaseCommit,
        lastReviewedCommit: secretPreflight.taskBaseCommit,
        pendingReview: null,
        checkpoints: [],
        finalReviewedCommit: null,
      },
      scope: "full",
      planSha256: null,
      testCaseSha256: null,
    });
  } catch {
    secretRejected = true;
  }
  check("sensitive-path-rejected", secretRejected, "secret path accepted");
  check(
    "sensitive-path-not-staged",
    !(await git(secretRoot, ["status", "--porcelain=v1"])).startsWith("A "),
    "secret path was staged",
  );

  const renamedSecretRoot = await createRepo();
  const renamedSecretPreflight = await service.preflight(renamedSecretRoot);
  await service.createRunBranch(
    renamedSecretRoot,
    "runweave/agt-renamed-secret",
  );
  await git(renamedSecretRoot, ["mv", "app.txt", "client.key"]);
  let renamedSecretRejected = false;
  try {
    await service.prepareReviewTarget({
      state: {
        mode: "local_commit",
        repoRoot: renamedSecretRoot,
        originalBranch: "main",
        branch: "runweave/agt-renamed-secret",
        taskBaseCommit: renamedSecretPreflight.taskBaseCommit,
        lastReviewedCommit: renamedSecretPreflight.taskBaseCommit,
        pendingReview: null,
        checkpoints: [],
        finalReviewedCommit: null,
      },
      scope: "full",
      planSha256: null,
      testCaseSha256: null,
    });
  } catch {
    renamedSecretRejected = true;
  }
  check(
    "renamed-sensitive-path-rejected",
    renamedSecretRejected,
    "renamed secret path accepted",
  );

  const nonGitRoot = await mkdtemp(
    path.join(os.tmpdir(), "runweave-agt-nongit-"),
  );
  roots.push(nonGitRoot);
  let nonGitRejected = false;
  try {
    await service.preflight(nonGitRoot);
  } catch {
    nonGitRejected = true;
  }
  check("non-git-rejected", nonGitRejected, "non-Git directory accepted");

  const detachedRoot = await createRepo();
  await git(detachedRoot, ["switch", "--detach"]);
  let detachedRejected = false;
  try {
    await service.preflight(detachedRoot);
  } catch {
    detachedRejected = true;
  }
  check("detached-head-rejected", detachedRejected, "detached HEAD accepted");

  const unbornRoot = await mkdtemp(
    path.join(os.tmpdir(), "runweave-agt-unborn-"),
  );
  roots.push(unbornRoot);
  await git(unbornRoot, ["init", "-b", "main"]);
  let unbornRejected = false;
  try {
    await service.preflight(unbornRoot);
  } catch {
    unbornRejected = true;
  }
  check("unborn-head-rejected", unbornRejected, "unborn HEAD accepted");

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
}

try {
  await main();
} finally {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
}
