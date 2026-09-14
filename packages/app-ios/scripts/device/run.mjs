import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { acquireLock } from "./lock.mjs";
import { preflight } from "./preflight.mjs";
import { loadSuite, prepare } from "./prepare.mjs";
import {
  alive,
  bundleID,
  command,
  DeviceError,
  deviceQuery,
  identity,
  pkg,
  readJSON,
  root,
  timestamp,
  treeDigest,
  writeJSON,
} from "./support.mjs";

export function status(runId) {
  let data;
  try {
    data = readJSON(resolve(root, "runs", runId, "run.json"));
  } catch {
    throw new DeviceError(
      "run_not_found",
      "status",
      "Use the runId emitted by device run in this worktree",
      2,
    );
  }
  if (
    !data.endedAt &&
    (!alive(data.pid) || identity(data.pid) !== data.startIdentity)
  ) {
    return {
      ...data,
      state: "unknown",
      error: {
        reason: "delivery_unknown",
        phase: data.state,
        evidencePath: data.evidencePath,
      },
      nextAction:
        "Inspect the owner lock and its children; status cannot resume or replay a run",
    };
  }
  return data;
}
export async function runBatch(options) {
  const suite = loadSuite(options.suite);
  const runId = randomUUID();
  const dir = resolve(root, "runs", runId);
  process.stderr.write(`device run ${runId}\nEvidence: ${dir}\n`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "Suite.swift"), suite.source);
  writeJSON(resolve(dir, "suite.json"), suite.manifest);
  const data = {
    schemaVersion: 1,
    toolInput: treeDigest([resolve(pkg, "scripts/device")]).digest,
    runId,
    pid: process.pid,
    startIdentity: identity(process.pid),
    worktree: pkg,
    device: { udid: options.device },
    suite: { path: suite.dir, digest: suite.digest, manifest: suite.manifest },
    state: "checking",
    startedAt: timestamp(),
    evidencePath: dir,
    counts: {
      appBuild: 0,
      appInstall: 0,
      runnerBuild: 0,
      xctestStart: 0,
      appRestart: 0,
      xcodeRunnerDeployment: "unknown",
    },
    cases: suite.manifest.cases.map((id) => ({ id, status: "blocked" })),
    export: { status: "not_started" },
  };
  const save = () => writeJSON(resolve(dir, "run.json"), data);
  const event = (kind, fields = {}) => {
    appendFileSync(
      resolve(dir, "events.jsonl"),
      JSON.stringify({ at: timestamp(), kind, ...fields }) + "\n",
    );
  };
  const phase = (state) => {
    data.state = state;
    event("phase", { state });
    save();
  };
  save();
  phase("checking");
  let lock,
    exitCode = 0;
  let startedBusiness = false,
    ready = false,
    batchFinished = false;
  const seenEvents = new Set();
  const acceptEvent = (entry) => {
    if (entry.runId !== runId) return;
    if (!Number.isInteger(entry.sequence) || seenEvents.has(entry.sequence))
      return;
    seenEvents.add(entry.sequence);
    event("runner_event", { event: entry });
    if (entry.kind === "automation_ready") {
      ready = true;
      phase("automation_ready");
    }
    const item = data.cases.find((c) => c.id === entry.caseId);
    if (entry.kind === "assertion" && item) {
      (item.assertions ||= []).push({
        passed: entry.passed,
        message: entry.message,
        at: entry.at,
      });
    }
    if (entry.kind === "case_started" && item) {
      startedBusiness = true;
      item.status = "unknown";
      item.startedAt = entry.at;
      phase("running");
    }
    if (entry.kind === "case_finished" && item) {
      item.status = entry.status;
      item.endedAt = entry.at;
      if (entry.message) item.message = entry.message;
    }
    if (entry.kind === "app_restart") data.counts.appRestart += 1;
    if (entry.kind === "batch_finished") batchFinished = true;
    save();
  };
  try {
    lock = acquireLock(options.device, runId);
    const report = await preflight(options, resolve(dir, "preflight"), runId);
    data.preflight = report;
    data.device = report.device;
    save();
    if (report.state === "blocked")
      throw new DeviceError(
        report.error.reason,
        "checking",
        report.nextAction,
        3,
        report.error.evidencePath,
      );
    const ctx = { options, report, suite, dir, lock, data, save, event };
    phase("preparing");
    const artifacts = await prepare(ctx);
    // Re-observe after potentially lengthy compilation, before touching the device.
    const fresh = await preflight(
      options,
      resolve(dir, "before-install"),
      runId,
    );
    if (fresh.state === "blocked")
      throw new DeviceError(
        fresh.error.reason,
        "preparing",
        fresh.nextAction,
        3,
        fresh.error.evidencePath,
      );
    if (!artifacts.unchanged())
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Inputs or signed artifacts changed after preparation; retry against stable inputs",
        5,
        dir,
      );
    event("app_install", {
      reason: "cross_batch_installed_build_identity_unknown",
      app: artifacts.app,
    });
    data.counts.appInstall += 1;
    save();
    const installed = await command(
      "xcrun",
      [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        options.device,
        artifacts.app,
        "--timeout",
        "60",
        "--json-output",
        resolve(dir, "install.json"),
      ],
      { dir, name: "install", timeout: 65000, owner: lock },
    );
    let installReceipt;
    try {
      installReceipt = readJSON(resolve(dir, "install.json"));
    } catch {
      /* No installation proof. */
    }
    const installedTarget = installReceipt?.result?.installedApplications?.find(
      (item) => item.bundleID === bundleID,
    );
    if (
      !installed.ok ||
      installReceipt?.info?.outcome !== "success" ||
      installReceipt?.result?.deviceIdentifier !== report.device.identifier ||
      !installedTarget?.installationURL
    )
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Installation failed; inspect install evidence before retrying",
        3,
        installed.evidencePath,
      );
    const installedApps = await deviceQuery(
      "apps",
      options.device,
      resolve(dir, "installed"),
      10000,
      lock,
    );
    const installedApp = installedApps.value?.apps?.find(
      (item) => item.bundleIdentifier === bundleID,
    );
    if (
      !installedApps.ok ||
      installedApp?.url !== installedTarget.installationURL
    )
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Unable to observe the installed target",
        3,
        installedApps.evidencePath,
      );
    data.installedApp = installedApp;
    save();
    const runConfig = resolve(dir, "batch.xctestrun");
    const configured = await command(
      "python3",
      [
        "-c",
        `import plistlib,sys\np=plistlib.load(open(sys.argv[1],'rb'))\ntargets=[t for c in p.get('TestConfigurations',[]) for t in c.get('TestTargets',[])] if 'TestConfigurations' in p else [v for k,v in p.items() if k!='__xctestrun_metadata__']\nfor t in targets:\n t.setdefault('EnvironmentVariables',{})['RUNWEAVE_RUN_ID']=sys.argv[3]\n t['OnlyTestIdentifiers']=['BatchRunner/testBatch']\ndef expand(v):\n if isinstance(v,str): return v.replace('__TESTROOT__',sys.argv[4])\n if isinstance(v,list): return [expand(x) for x in v]\n if isinstance(v,dict): return {k:expand(x) for k,x in v.items()}\n return v\nplistlib.dump(expand(p),open(sys.argv[2],'wb'))`,
        artifacts.xctestrun,
        runConfig,
        runId,
        resolve(artifacts.runnerDD, "Build/Products"),
      ],
      { dir, name: "run-config", owner: lock },
    );
    if (!configured.ok)
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Cannot prepare the run-specific xctestrun",
        5,
        configured.evidencePath,
      );
    phase("starting_automation");
    const xcresult = resolve(dir, "result.xcresult");
    data.counts.xctestStart += 1;
    save();
    let authorizationSeen = false;
    const controller = new AbortController();
    let authTimer;
    const execution = await command(
      "xcodebuild",
      [
        "test-without-building",
        "-xctestrun",
        runConfig,
        "-destination",
        `platform=iOS,id=${options.device}`,
        "-parallel-testing-enabled",
        "NO",
        "-test-timeouts-enabled",
        "YES",
        "-default-test-execution-time-allowance",
        String(suite.manifest.timeoutSeconds || 180),
        "-maximum-test-execution-time-allowance",
        String(suite.manifest.timeoutSeconds || 180),
        "-resultBundlePath",
        xcresult,
      ],
      {
        dir,
        name: "xctest",
        timeout: ((suite.manifest.timeoutSeconds || 180) + 180) * 1000,
        owner: lock,
        signal: controller.signal,
        onLine(line) {
          const index = line.indexOf("RUNWEAVE_DEVICE_EVENT ");
          if (index >= 0) {
            try {
              const entry = JSON.parse(line.slice(index + 22));
              if (entry.runId === runId && entry.kind === "automation_ready")
                clearTimeout(authTimer);
              acceptEvent(entry);
            } catch {
              /* Partial log lines cannot prove success. */
            }
          }
          if (
            !ready &&
            !authorizationSeen &&
            /(?:passcode.*(?:UI automation|automated testing)|(?:UI automation|automated testing).*(?:passcode|authorization required))/i.test(
              line,
            )
          ) {
            authorizationSeen = true;
            phase("waiting_for_user");
            event("authorization_wait", {
              timeoutSeconds: 120,
              evidence: line,
            });
            process.stderr.write(
              "目标设备要求 UI Automation 授权，请在设备上处理；保留本轮 Xcode 最多等待 120 秒。\n",
            );
            authTimer = setTimeout(() => controller.abort(), 120000);
          }
        },
      },
    );
    clearTimeout(authTimer);
    data.execution = {
      code: execution.code,
      signal: execution.signal,
      timedOut: execution.timedOut,
      authorizationSeen,
    };
    save();
    if (!existsSync(xcresult)) {
      data.export = { status: "unavailable", xcresult };
      throw new DeviceError(
        startedBusiness
          ? "delivery_unknown"
          : authorizationSeen
            ? "automation_authorization_required"
            : "automation_start_failed",
        "starting_automation",
        "XCTest exited without a result bundle; inspect the log and do not replay unknown actions",
        startedBusiness ? 5 : 3,
        execution.evidencePath,
      );
    }
    // Export even for assertions/startup failures. Keep the original xcresult on every path.
    const attachments = resolve(dir, "attachments");
    event("evidence_export_started");
    const exported = existsSync(xcresult)
      ? await command(
          "xcrun",
          [
            "xcresulttool",
            "export",
            "attachments",
            "--path",
            xcresult,
            "--output-path",
            attachments,
          ],
          { dir, name: "export", timeout: 60000, owner: lock },
        )
      : { ok: false };
    data.export = {
      status: exported.ok ? "exported" : "failed",
      path: attachments,
      xcresult,
    };
    save();
    event("evidence_export_finished", data.export);
    if (!exported.ok) {
      data.businessResult =
        data.cases.every((item) => item.status === "pass") && batchFinished
          ? "pass"
          : data.cases.some((item) => item.status === "fail")
            ? "fail"
            : "unknown";
      throw new DeviceError(
        "evidence_export_failed",
        "exporting",
        "Export attachments again from the retained xcresult; do not replay the suite",
        5,
        xcresult,
      );
    }
    const manifest = readJSON(resolve(attachments, "manifest.json"));
    const files = manifest.flatMap((item) => item.attachments || []);
    const trace = files.find((item) =>
      item.suggestedHumanReadableName?.startsWith("batch-events"),
    );
    // Exported run-bound events are authoritative if stdout was buffered or lost.
    if (trace) {
      const entries = readJSON(resolve(attachments, trace.exportedFileName));
      if (
        !Array.isArray(entries) ||
        entries.some((entry) => entry.runId !== runId)
      )
        throw new DeviceError(
          "delivery_unknown",
          "exporting",
          "Runner event identity does not match this run",
          5,
          attachments,
        );
      for (const entry of entries) acceptEvent(entry);
    }
    for (const item of data.cases)
      item.evidence = files
        .filter((file) =>
          file.suggestedHumanReadableName?.startsWith(item.id + "-"),
        )
        .map((file) => resolve(attachments, file.exportedFileName));
    const summary = await command(
      "xcrun",
      [
        "xcresulttool",
        "get",
        "test-results",
        "summary",
        "--path",
        xcresult,
        "--compact",
      ],
      { dir, name: "summary", timeout: 30000, owner: lock },
    );
    if (summary.ok) data.xctestSummary = JSON.parse(summary.output);
    let finalApps;
    const observationDeadline = Date.now() + 30000;
    // CoreDevice can stall immediately after XCTest teardown. Only repeat this
    // read-only observation, after its owned process has exited; never replay UI.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Reserve the command's five-second forced-exit grace inside the budget.
      const remaining = observationDeadline - Date.now() - 5000;
      if (remaining <= 0) break;
      if (attempt > 1)
        event("read_only_recheck", {
          attempt,
          reason: "post_xctest_metadata_timeout",
          previousEvidence: finalApps.evidencePath,
        });
      finalApps = await deviceQuery(
        "apps",
        options.device,
        resolve(dir, attempt === 1 ? "after-run" : `after-run-${attempt}`),
        Math.min(10000, remaining),
        lock,
      );
      if (finalApps.ok || !finalApps.timedOut) break;
    }
    if (
      !finalApps.ok ||
      finalApps.value?.apps?.find((item) => item.bundleIdentifier === bundleID)
        ?.url !== installedApp.url
    )
      throw new DeviceError(
        "delivery_unknown",
        "running",
        "Target installation identity changed or became unobservable; coordinate other device owners",
        5,
        dir,
      );
    if (
      !ready &&
      /maximum number of installed apps using a free developer profile/i.test(
        execution.output,
      )
    )
      throw new DeviceError(
        "signing_unavailable",
        "starting_automation",
        "The signing installation quota is full; use an idle existing test runner's base ID via --runner-bundle-id, or a suitable Xcode signing team",
        3,
        execution.evidencePath,
      );
    if (!ready)
      throw new DeviceError(
        authorizationSeen
          ? "automation_authorization_required"
          : "automation_start_failed",
        "starting_automation",
        "Inspect the Xcode log and target device; this XCTest has exited",
        3,
        execution.evidencePath,
      );
    if (data.cases.some((item) => item.status === "fail"))
      throw new DeviceError(
        "case_failed",
        "running",
        "Inspect the failing case attachments; remaining cases were not executed",
        4,
        attachments,
      );
    if (
      !execution.ok ||
      !trace ||
      !batchFinished ||
      !summary.ok ||
      data.xctestSummary?.failedTests !== 0 ||
      data.xctestSummary?.passedTests !== 1 ||
      data.cases.some(
        (item) => item.status !== "pass" || item.evidence.length < 4,
      )
    )
      throw new DeviceError(
        startedBusiness ? "delivery_unknown" : "automation_start_failed",
        "running",
        "Incomplete execution evidence; do not replay unknown business actions",
        5,
        xcresult,
      );
    phase("finished");
  } catch (error) {
    exitCode = error.exitCode || 5;
    data.error = {
      phase: error.phase || data.state,
      reason: error.reason || "runner_failed",
      evidencePath: error.evidencePath || dir,
      message: error.message,
    };
    data.nextAction =
      error.nextAction || "Inspect run evidence before retrying";
    phase(exitCode === 4 ? "failed" : exitCode === 3 ? "blocked" : "unknown");
  } finally {
    data.endedAt = timestamp();
    data.exitCode = exitCode;
    data.processes = lock?.owner.children;
    if (existsSync(resolve(dir, "commands.jsonl")))
      data.timings = readFileSync(resolve(dir, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((entry) => entry.kind === "command_finished");
    const events = readFileSync(resolve(dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const observed = (kind, state) =>
      events.find(
        (entry) => entry.kind === kind && (!state || entry.state === state),
      );
    const startup = observed("phase", "starting_automation");
    const active = observed("phase", "automation_ready");
    const waiting = observed("authorization_wait");
    const span = (from, to) =>
      from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : "unknown";
    data.measurements = {
      totalMs: span(data.startedAt, data.endedAt),
      automationStartupMs: span(startup?.at, active?.at),
      authorizationWaitMs: waiting
        ? span(waiting.at, active?.at || data.endedAt)
        : "not_observed",
      cases: data.cases.map((item) => ({
        id: item.id,
        durationMs: span(item.startedAt, item.endedAt),
      })),
      timingSource:
        "host log observations; case timestamps have one-second resolution",
    };
    data.lockReleased = lock ? lock.release() : false;
    if (lock && !data.lockReleased) {
      data.lockWarning =
        "Owned child processes may still be alive; retained lock requires inspection";
      if (!exitCode) {
        exitCode = 5;
        data.exitCode = 5;
        data.state = "unknown";
      }
    }
    event("run_finished", { state: data.state, exitCode });
    save();
  }
  return { data, exitCode };
}
