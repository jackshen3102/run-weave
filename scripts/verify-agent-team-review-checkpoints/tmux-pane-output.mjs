import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TmuxOutputWatcher } from "../../backend/src/terminal/tmux-output-watcher.ts";
import { TmuxService } from "../../backend/src/terminal/tmux-service.ts";

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
