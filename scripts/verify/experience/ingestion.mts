import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
import type { AgentHookStateRequest } from "@runweave/shared/terminal/events";
import type { AppServerEventEnvelope } from "@runweave/shared/app-server-events";

// Integration acceptance: real HTTP router, persistent session manager and encrypted
// SQLite Activity worker. Only the provider hook input is a controlled fixture.
const require = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const express = require("express");
async function verify(
  caseId: "EXPLEARN-001" | "EXPLEARN-002",
  withPanel: boolean,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "experience-ingestion-"));
  const store = await ActivityStore.create({
    databasePath: path.join(root, "activity.sqlite"),
    env: {
      ...process.env,
      RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
      RUNWEAVE_ACTIVITY_TEST_MODE: "true",
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
    // Oversized content must still fail closed through the real Activity writer.
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
      bytesBase64: Buffer.from("x".repeat(40_001)).toString("base64"),
    });
    assert.equal((await store.record([oversized]))[0].status, "committed");
    await assert.rejects(
      readLearningFacts(store, {
        ...source,
        completedAt: new Date().toISOString(),
        asOfActivityOffset: undefined,
      }),
      /experience_source_too_large/,
    );
    console.log(
      "EXPLEARN-002 PASS: empty stdout remains valid; complete prompt/tool/response recovered; oversized evidence fails closed",
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

for (const caseId of ["EXPLEARN-001", "EXPLEARN-002"] as const)
  for (const withPanel of [false, true]) await verify(caseId, withPanel);
