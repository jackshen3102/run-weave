import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ActivityStore } from "../../../backend/src/activity/recording/store";
import { ActivityEventFactory } from "../../../backend/src/activity/recording/event-factory";
import { ActivityRecorder } from "../../../backend/src/activity/recording/recorder";
import { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import { LowDbTerminalSessionStore } from "../../../backend/src/terminal/store/lowdb-store";
import { TerminalStateStore } from "../../../backend/src/terminal/state/terminal-state-store";
import { TerminalStateService } from "../../../backend/src/terminal/state/terminal-state-service";
import { handleAgentHookEvent } from "../../../backend/src/app-server/handlers/agent-hook";
import { createInternalTerminalAgentHookRouter } from "../../../backend/src/routes/terminal/state";
import { readLearningFacts } from "../../../backend/src/experience/learning-source";
import { ExperienceService } from "../../../backend/src/experience/service";
import { ExperienceLearningQueue } from "../../../backend/src/experience/learning-queue";
import { ExperienceLearningAnalysis } from "../../../backend/src/experience/learning-analysis";
import { LearningDeferred, splitLearningFacts } from "../../../backend/src/experience/learning-segments";
import type { LearningFact } from "../../../backend/src/experience/learning-source";
import type { AgentHookStateRequest } from "@runweave/shared/terminal/events";
import type { AppServerEventEnvelope } from "@runweave/shared/app-server-events";

// Integration acceptance: real HTTP router, persistent session manager and encrypted
// SQLite Activity worker. Only the provider hook input is a controlled fixture.
const require = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const express = require("express");
const { extractToolHook } = require(new URL("../../../packages/agent-bridge/hooks/runweave-hook-payload.cjs", import.meta.url).pathname);
async function verify(
  caseId: "EXPLEARN-001" | "EXPLEARN-002",
  withPanel: boolean,
  productionKey = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "experience-ingestion-"));
  const store = await ActivityStore.create({
    databasePath: path.join(root, "activity.sqlite"),
    env: {
      ...process.env,
      RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
      RUNWEAVE_ACTIVITY_TEST_MODE: productionKey ? "false" : "true",
      RUNWEAVE_ACTIVITY_HOME: root,
    },
  });
  const manager = new TerminalSessionManager(
    new LowDbTerminalSessionStore(path.join(root, "sessions.json")),
  );
  const state = new TerminalStateService(new TerminalStateStore());
  const factory = new ActivityEventFactory({
    producerName: "experience-acceptance",
    producerVersion: "1",
    producerInstanceId: crypto.randomUUID(),
    runtimeChannel: "dev",
    runtimeSurface: "backend",
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/hook",
    createInternalTerminalAgentHookRouter({
      terminalSessionManager: manager,
      terminalStateService: state,
      hookToken: "isolated-acceptance",
      activity: {
        eventFactory: factory,
        recorder: new ActivityRecorder(store),
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await manager.initialize();
    const project = await manager.createProject("Experience acceptance", root);
    const session = await manager.createSession({
      projectId: project.id,
      command: "pi",
      cwd: root,
    });
    const workerCwd = path.join(root, "worker-checkout");
    await mkdir(workerCwd);
    const panelId = withPanel ? crypto.randomUUID() : null;
    if (panelId)
      await manager.upsertPanel({
        id: panelId,
        terminalSessionId: session.id,
        alias: null,
        role: null,
        agentTeamRunId: null,
        agentTeamWorkerId: null,
        cwd: workerCwd,
        activeCommand: "pi",
        status: "running",
        createdAt: new Date(),
        lastActivityAt: new Date(),
        runtimeKind: "tmux",
        tmuxPaneId: "%acceptance",
      });
    const threadId = crypto.randomUUID();
    const pi = {
      version: 1 as const,
      sessionId: threadId,
      sessionFile: null,
      instanceId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      sequence: 1,
      runId: crypto.randomUUID(),
      leafId: null,
      event: "user_message",
      outcome: null,
    };
    const hook: AgentHookStateRequest = {
      terminalSessionId: session.id,
      panelId,
      threadId,
      agent: "pi",
      hookEvent: "UserPromptSubmit",
      commandName: "pi",
      pi,
      query: "Check a command with empty stdout",
      activityEventId: crypto.randomUUID(),
    };
    async function post(
      body: AgentHookStateRequest,
      token = "isolated-acceptance",
    ) {
      const response = await fetch(base + "/hook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-runweave-hook-token": token,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const envelope = (body: AgentHookStateRequest): AppServerEventEnvelope =>
      ({
        id: crypto.randomUUID(),
        version: 1,
        kind: "agent.hook",
        createdAt: new Date().toISOString(),
        source: { app: "hook", instanceId: "isolated-pi", pid: process.pid },
        scope: { terminalSessionId: session.id, terminalPanelId: panelId },
        correlationId: threadId,
        payload: {
          source: "pi",
          stateHookEvent: body.hookEvent,
          commandName: "pi",
          pi: body.pi,
        },
      }) as AppServerEventEnvelope;
    const options = {
      terminalSessionManager: manager,
      terminalStateService: state,
    };
    // Reproduce the observed delivery order: state accepted before content arrives.
    await handleAgentHookEvent(envelope(hook), options);
    if (caseId === "EXPLEARN-001") {
      const acceptedState = state.getCurrent(session.id, session);
      assert.equal((await post(hook, "wrong-token")).status, 401);
      assert.equal((await post(hook)).status, 202);
      await post(hook); // Same delivery id must not duplicate Activity.
      assert.deepEqual(state.getCurrent(session.id, session), acceptedState);
      let facts = await store.facts({
        threadId,
        terminalSessionId: session.id,
        limit: 100,
      });
      assert.equal(
        facts.facts.filter((f) => f.eventName === "user.query.submit_requested")
          .length,
        1,
      );
      await post({
        ...hook,
        activityEventId: crypto.randomUUID(),
        panelId: "wrong-panel",
      });
      await post({
        ...hook,
        activityEventId: crypto.randomUUID(),
        pi: { ...pi, runId: "different-run" },
      });
      const newer = {
        ...hook,
        activityEventId: crypto.randomUUID(),
        pi: { ...pi, sequence: 2 },
      };
      assert.equal((await post(newer)).body.disposition, "recorded");
      await handleAgentHookEvent(envelope(newer), options); // Reverse delivery order.
      await post({ ...hook, activityEventId: crypto.randomUUID() }); // Older sequence.
      facts = await store.facts({
        threadId,
        terminalSessionId: session.id,
        limit: 100,
      });
      assert.equal(
        facts.facts.length,
        2,
        "bad identity, same-sequence conflict and stale events must not record",
      );
      assert.equal(
        (panelId ? manager.getPanel(panelId) : manager.getSession(session.id))
          ?.pi?.sequence,
        2,
      );
      console.log(
        "EXPLEARN-001 PASS: both transport orders; authenticated exact replay; duplicates/stale/conflicting identity rejected",
      );
      return;
    }
    await post(hook);
    const newer = {
      ...hook,
      activityEventId: crypto.randomUUID(),
      pi: { ...pi, sequence: 2 },
    };
    const toolUseId = crypto.randomUUID();
    await post({
      ...newer,
      activityEventId: crypto.randomUUID(),
      hookEvent: "ToolRequested",
      pi: { ...pi, sequence: 3, event: "tool_execution_start" },
      toolUseId,
      toolName: "Bash",
      toolInput: "true",
    });
    await post({
      ...newer,
      activityEventId: crypto.randomUUID(),
      hookEvent: "ToolCompleted",
      pi: { ...pi, sequence: 4, event: "tool_execution_end" },
      toolUseId,
      toolName: "Bash",
      toolResult: "",
    });
    const stop: AgentHookStateRequest = {
      ...newer,
      hookEvent: "Stop",
      activityEventId: crypto.randomUUID(),
      response: "Command completed",
      pi: { ...pi, sequence: 5, event: "agent_settled", outcome: "completed" },
    };
    await handleAgentHookEvent(envelope(stop), options);
    await post(stop);
    const snapshot = await store.facts({
      threadId,
      terminalSessionId: session.id,
      limit: 100,
    });
    assert.ok(
      snapshot.facts.every(
        (f) => f.scope.cwd === (withPanel ? workerCwd : root),
      ),
      JSON.stringify({
        withPanel,
        root,
        workerCwd,
        facts: snapshot.facts.map((f) => ({
          eventName: f.eventName,
          scope: f.scope,
        })),
      }),
    );
    const source = {
      terminalSessionId: session.id,
      threadId,
      panelId,
      completedAt: new Date().toISOString(),
      channel: "dev" as const,
      asOfActivityOffset: snapshot.asOfActivityOffset,
    };
    const learned = await readLearningFacts(store, source);
    assert.deepEqual(
      learned.map((f) => f.kind),
      [
        "user.query.submit_requested",
        "agent.tool.requested",
        "agent.tool.completed",
        "agent.response.observed",
      ],
    );
    assert.equal(
      learned.find((f) => f.kind === "agent.tool.completed")!.text,
      "",
    );
    assert.equal(snapshot.facts.find((f) => f.eventName === "agent.tool.completed")!.result, undefined);
    // Real command outcomes -> provider metadata -> authenticated HTTP -> SQLite.
    // Identical stdout must never be used to infer success.
    const success = spawnSync(process.execPath, ["-e", "process.stdout.write('same output');process.exit(0)"], { encoding: "utf8" });
    const failure = spawnSync(process.execPath, ["-e", "process.stdout.write('same output');process.exit(7)"], { encoding: "utf8" });
    assert.equal(success.status, 0);
    assert.equal(failure.status, 7);
    const outcomes = [
      { response: { stdout: success.stdout, exit_code: success.status }, expected: { status: "succeeded", code: "exit_code:0" } },
      { response: { stdout: failure.stdout, exit_code: failure.status }, expected: { status: "failed", code: "exit_code:7" } },
      { response: failure.stdout, expected: undefined },
      { response: '{"exit_code":0,"is_error":false}', expected: undefined },
      { response: { exit_code: "0", is_error: "false" }, expected: undefined },
      { response: { is_error: true }, expected: { status: "failed" } },
      { response: { is_error: false }, expected: { status: "succeeded" } },
      { response: { exit_code: 0, is_error: true }, expected: { status: "failed", code: "exit_code:0" } },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const eventId = crypto.randomUUID();
      const body: AgentHookStateRequest = {
        ...newer,
        activityEventId: eventId,
        hookEvent: "ToolCompleted",
        pi: { ...pi, sequence: 6 + index, event: "tool_execution_end" },
        ...extractToolHook({ tool_use_id: crypto.randomUUID(), tool_name: "Bash", tool_response: outcome.response }),
      };
      assert.equal((await post(body)).status, 202);
      await post(body); // Duplicate delivery must preserve the same outcome.
      const page = await store.facts({ threadId, limit: 100 });
      const matching = page.facts.filter((f) => f.eventId === eventId);
      assert.equal(matching.length, 1);
      assert.deepEqual(matching[0].result, outcome.expected);
    }
    console.log("Tool outcomes PASS: explicit success/failure persisted; unknown stays unknown; duplicate delivery is idempotent");
    const missingThread = crypto.randomUUID();
    await store.record([factory.create({
      eventName: "user.query.submit_requested",
      scope: { threadId: missingThread, terminalSessionId: session.id, panelId: panelId ?? undefined },
    })]);
    await assert.rejects(readLearningFacts(store, {
      ...source, threadId: missingThread, completedAt: new Date().toISOString(), asOfActivityOffset: undefined,
    }), /experience_source_unavailable/);
    // Large text must survive the real Activity writer without silent truncation.
    const oversized = factory.create({
      eventName: "agent.tool.completed",
      actorType: "agent",
      actorAgent: "pi",
      scope: {
        threadId,
        terminalSessionId: session.id,
        panelId: panelId ?? undefined,
      },
      payload: { toolUseId, toolName: "Bash" },
    });
    oversized.contents.push({
      contentId: crypto.randomUUID(),
      role: "tool_result",
      mediaType: "text/plain",
      bytesBase64: Buffer.from("证据🙂".repeat(19_000) + "LATE_FAILURE").toString("base64"),
    });
    assert.equal((await store.record([oversized]))[0].status, "committed");
    const largeFacts = await readLearningFacts(store, {
      ...source,
      completedAt: new Date().toISOString(),
      asOfActivityOffset: undefined,
    });
    assert.equal(largeFacts.find((fact) => fact.id === oversized.eventId)?.text, "证据🙂".repeat(19_000) + "LATE_FAILURE");
    await verifySegmentedLearning(root, largeFacts);
    console.log(
      "EXPLEARN-002 PASS: empty stdout remains valid; complete prompt/tool/response recovered; large evidence preserved intact",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error) => (error ? reject(error) : resolve())),
    );
    await manager.dispose();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

// Real SQLite queue/candidate/evidence lifecycle; a controlled provider injects
// a misleading early candidate and a later contradiction, plus one interrupted call.
async function verifySegmentedLearning(root: string, facts: LearningFact[]) {
  const pieces = splitLearningFacts(facts);
  for (const fact of facts) {
    assert.equal(pieces.filter((p) => p.id === fact.id || p.source?.eventId === fact.id).map((p) => p.text).join(""), fact.text);
  }
  const storage = { home: root, namespace: "segmented" };
  const service = new ExperienceService(storage);
  const scope = await service.scope(process.cwd());
  let queue = new ExperienceLearningQueue(storage);
  const jobId = crypto.randomUUID();
  const input = {
    jobId, repositoryId: scope.repositoryId, cwd: scope.root,
    threadId: "segmented-acceptance", createdAt: new Date().toISOString(),
    source: { terminalSessionId: "fixture", threadId: "segmented-acceptance", panelId: null, completedAt: new Date().toISOString(), channel: "dev" as const },
  };
  queue.enqueue(input);
  const request = pieces.find((p) => p.kind === "agent.tool.requested")!;
  const result = pieces.find((p) => p.source && p.toolUseId === request.toolUseId)!;
  const counts = new Map<string, number>();
  let interrupted = false;
  let yielded = false;
  let audited = 0;
  const provider = {
    provider: "codex" as const,
    async run({ prompt }: { prompt: string }) {
      let output: unknown;
      if (prompt.startsWith("整理长任务")) {
        const index = prompt.match(/第 (\d+)\//)![1];
        counts.set(index, (counts.get(index) ?? 0) + 1);
        if (index === "2" && counts.get(index)! <= 2) {
          interrupted = true;
          throw new Error("provider_output_invalid_json");
        }
        output = { coverage: index === "1" && counts.get(index) === 1 ? "incomplete" : "complete", observations: "Early output; later failure must be checked", limitations: "partial input", evidenceIds: [] };
      } else if (prompt.startsWith("从长任务索引")) {
        output = { evidenceIds: [request.id, result.id], reason: "retrieve raw evidence" };
      } else if (prompt.startsWith("从本轮")) {
        assert.ok(prompt.includes("已按索引取回的原始证据"));
        assert.ok(prompt.includes(result.text));
        output = { reason: "controlled candidate", candidate: {
          draft: { id: "segmented-acceptance", title: "A deliberately unsupported success",
            triggers: [["terminal"], ["verification"]], applicability: "fixture only",
            avoid: ["ignore errors"], actions: ["run command"], verification: ["all operations succeeded"] },
          evidenceIds: [request.id, result.id],
        } };
      } else if (prompt.startsWith("独立检查候选")) {
        audited++;
        const raw = prompt.split("本段原文=")[1];
        output = { verdict: raw.includes("LATE_FAILURE") ? "contradicted" : "compatible", reason: "checked raw segment" };
      } else throw new Error("Unexpected final approval after contradiction");
      return { provider: "codex" as const, durationMs: 0, events: [], output };
    },
  };
  for (let batch = 0; batch < 12; batch++) {
    queue = new ExperienceLearningQueue(storage); // Reopen persisted progress.
    const job = queue.claim()!;
    assert.ok(job);
    try {
      const outcome = await new ExperienceLearningAnalysis(service, queue, provider).run(job, facts, new AbortController().signal);
      queue.update(job, outcome);
      assert.equal(outcome.status, "completed");
      const candidate = (await service.candidates(scope.root))[0];
      assert.equal(candidate.review?.verdict, "contradicted");
      assert.equal((await service.listRecords(scope.root)).length, 0);
      assert.ok(interrupted && yielded && audited >= 4);
      assert.equal(counts.get("1"), 2, "incomplete output must retry; completed segment must not rerun");
      assert.equal(counts.get("2"), 3, "only failed segment should retry");
      assert.ok(candidate.record.evidence.every((e) => Buffer.byteLength(e.archived!.text) < 64 * 1024));
      queue.clearCheckpoints(job);
      assert.throws(() => queue.saveCheckpoint(job, "late", {}), /claim_lost/);
      console.log("Segmented learning PASS: full source, persisted retry/resume, fair scheduling, late contradiction prevents promotion, bounded evidence, stale claim rejected");
      return;
    } catch (error) {
      if (!(error instanceof LearningDeferred) && !["provider_output_invalid_json", "experience_partial_segment_analysis_incomplete"].includes((error as Error).message)) throw error;
      queue.update(job, { status: error instanceof LearningDeferred ? "queued" : "failed", reason: (error as Error).message });
      if (!(error instanceof LearningDeferred)) queue.retry(scope.repositoryId, jobId);
      else if (!yielded) {
        yielded = true;
        queue.enqueue({ ...input, jobId: "other", createdAt: "2000-01-01T00:00:00.000Z" });
        const other = queue.claim()!;
        assert.equal(other.jobId, "other", "long analysis must yield to other work");
        queue.update(other, { status: "skipped" });
      }
    }
  }
  throw new Error("segmented analysis never completed");
}

for (const caseId of ["EXPLEARN-001", "EXPLEARN-002"] as const)
  for (const withPanel of [false, true]) await verify(caseId, withPanel);

if (process.platform === "linux") {
  await verify("EXPLEARN-002", true, true);
  console.log("Linux production key PASS: real HTTP hook, SQLite content and learning source; no test key");
}
