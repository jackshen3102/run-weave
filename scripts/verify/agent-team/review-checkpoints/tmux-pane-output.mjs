import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TmuxOutputWatcher } from "../../../../backend/src/terminal/tmux/output-watcher.ts";
import { TmuxService } from "../../../../backend/src/terminal/tmux/service.ts";

const execFileAsync = promisify(execFile);
let recordCheck = null;
let cleanupRoots = null;

function check(...args) {
  return recordCheck(...args);
}

async function verifyTmuxPaneRawOutputHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runweave-tmux-pane-"));
  cleanupRoots.push(root);
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
      "printf 'MAIN_PANE_OUTPUT\\n'",
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
      "tmux-other-pane-output-is-isolated",
      mainOutput?.includes("MAIN_PANE_OUTPUT") === true &&
        workerOutputBeforeLaunch?.includes("MAIN_PANE_OUTPUT") === false &&
        mismatchedOutput === null,
      { mainOutput, workerOutputBeforeLaunch, mismatchedOutput },
    );

    await sendTmuxFixtureCommand(
      runTmux,
      workerPaneId,
      "printf 'MAIN_SCREEN_BEFORE_ALT\\n\\033[?1049hALT_SCREEN_OUTPUT\\n'",
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
        workerRawOutput.includes("ALT_SCREEN_OUTPUT") &&
        !workerCapture.includes("MAIN_SCREEN_BEFORE_ALT") &&
        workerCapture.includes("ALT_SCREEN_OUTPUT"),
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
      "FRESH_OUTPUT_AFTER_TRANSPORT_RESET",
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
    await watcher.removeMissingPaneWatchers();
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
    await verifyPollingIsolation(root, session, tmuxService, runTmux, mainTarget);
  } finally {
    await watcher?.dispose();
    await runTmux(["kill-server"]).catch(() => undefined);
  }
}

// Exercise production timers and real tmux pipes while tmux queries wait on a
// controlled server-side barrier. No installed server or user session is touched.
async function verifyPollingIsolation(root, session, tmuxService, runTmux, target) {
  const listPanes = tmuxService.listPanes.bind(tmuxService);
  const readPaneMetadata = tmuxService.readPaneMetadata.bind(tmuxService);
  const originalArgs = session.args;
  let output = "";
  let listCalls = 0;
  let activeQueries = 0;
  let maxActiveQueries = 0;
  let metadataCalls = 0;
  const manager = {
    getSession: (id) => id === session.id ? session : null,
    appendOutput: (_id, text) => { output += text; },
    updateSessionMetadata: async () => {},
    markExited: () => { throw new Error("live fixture must not be marked exited"); },
  };
  const watcher = new TmuxOutputWatcher({
    outputDir: path.join(root, "isolation-output"),
    terminalSessionManager: manager,
    tmuxService,
    pollIntervalMs: 25,
    reconciliationIntervalMs: 50,
  });
  tmuxService.listPanes = async (value) => {
    const call = ++listCalls;
    activeQueries += 1;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
    try {
      if (call === 1) await runTmux(["wait-for", "release-pane-query"]);
      if (call === 2) throw new Error("fixture transient query failure");
      return await listPanes(value);
    } finally {
      activeQueries -= 1;
    }
  };
  try {
    await watcher.watchSession(session);
    await waitForFixtureCondition(() => listCalls === 1, "reconciliation did not start");
    await sendTmuxFixtureCommand(runTmux, target.paneId, "printf 'OUTPUT_DURING_QUERY_STALL\\n'");
    await waitForFixtureCondition(() => output.includes("OUTPUT_DURING_QUERY_STALL"), "output blocked on list-panes");
    await new Promise((resolve) => setTimeout(resolve, 220));
    check("tmux-query-stall-does-not-overlap-or-block-output", listCalls === 1 && maxActiveQueries === 1 && activeQueries === 1, { listCalls, maxActiveQueries });
    await runTmux(["wait-for", "-S", "release-pane-query"]);
    await waitForFixtureCondition(() => listCalls >= 3, "reconciliation did not recover after failure");
    check("tmux-query-failure-recovers-without-overlap", maxActiveQueries === 1, { listCalls, maxActiveQueries });
    await watcher.unwatchSession(session.id);
    check("tmux-idle-stops-both-schedulers", !watcher.pollTimer && !watcher.reconciliationTimer, {});
    await watcher.watchSession(session);
    check("tmux-watch-rearms-both-schedulers", Boolean(watcher.pollTimer && watcher.reconciliationTimer), {});

    // Exercise the noninteractive metadata path independently of list-panes.
    session.args = ["-c"];
    tmuxService.readPaneMetadata = async (...args) => {
      metadataCalls += 1;
      await runTmux(["wait-for", "release-metadata-query"]);
      return readPaneMetadata(...args);
    };
    await waitForFixtureCondition(() => metadataCalls === 1, "metadata reconciliation did not start");
    await sendTmuxFixtureCommand(runTmux, target.paneId, "printf 'OUTPUT_DURING_METADATA_STALL\\n'");
    await waitForFixtureCondition(() => output.includes("OUTPUT_DURING_METADATA_STALL"), "output blocked on metadata");
    let disposed = false;
    const disposal = watcher.dispose().then(() => { disposed = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    check("tmux-dispose-waits-for-inflight-reconciliation", !disposed && metadataCalls === 1, { disposed, metadataCalls });
    await runTmux(["wait-for", "-S", "release-metadata-query"]);
    await disposal;
    const callsAtDispose = listCalls + metadataCalls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    check("tmux-dispose-leaves-no-timers-or-late-queries", disposed && !watcher.pollTimer && !watcher.reconciliationTimer && watcher.watchedPanes.size === 0 && callsAtDispose === listCalls + metadataCalls, { listCalls, metadataCalls });
  } finally {
    await runTmux(["wait-for", "-S", "release-pane-query"]);
    await runTmux(["wait-for", "-S", "release-metadata-query"]);
    await watcher.dispose();
    tmuxService.listPanes = listPanes;
    tmuxService.readPaneMetadata = readPaneMetadata;
    session.args = originalArgs;
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

export async function verifyTmuxPaneOutput(checkResult, roots) {
  recordCheck = checkResult;
  cleanupRoots = roots;
  try {
    await verifyTmuxPaneRawOutputHarness();
  } finally {
    recordCheck = null;
    cleanupRoots = null;
  }
}
