// Real tmux dispatch into an owned CLI probe; no model output is used as proof.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withHarness } from "../verify/agent-team/review-checkpoints/bootstrap/harness.mjs";
import { AgentTeamService } from "../../backend/src/agent-team/service.ts";
import { createInitialLoop } from "../../backend/src/agent-team/loop.ts";
import { InMemoryEvolutionActivationStore } from "../../backend/src/evolution/activation-store.ts";
import { DefaultEvolutionMemoryProvider } from "../../backend/src/evolution/injection/memory-provider.ts";
import { StructuredEvolutionMemorySelector } from "../../backend/src/evolution/knowledge/retrieval.ts";
import { createCandidateAsset } from "../../backend/src/evolution/knowledge/candidate-factory.ts";
import { defaultEvolutionScopePolicy } from "../../backend/src/evolution/knowledge/lifecycle.ts";
import { resolveRepositoryIdentity } from "../../backend/src/repository/identity.ts";
const roots = [],
  evidence = [];
try {
  await withHarness(roots, async (h) => {
    const store = new InMemoryEvolutionActivationStore();
    const locations = [
      path.join(h.session.cwd, "repo-a"),
      path.join(h.session.cwd, "repo-b"),
      path.join(h.session.cwd, "plain"),
    ];
    const binary = path.join(h.session.cwd, "codex");
    await writeFile(
      binary,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.cwd()+'/worker-observed.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),pid:process.pid}));setInterval(()=>{},1000);\n`,
    );
    await chmod(binary, 0o700);
    const assets = [];
    for (let i = 0; i < locations.length; i++) {
      await mkdir(locations[i]);
      if (i === 2) continue;
      execFileSync("git", ["init", locations[i]], { stdio: "ignore" });
      const id = (await resolveRepositoryIdentity(locations[i])).repositoryId;
      await store.putPolicy({
        ...defaultEvolutionScopePolicy(id),
        memoryCanaryEnabled: true,
        canaryRate: 1,
      });
      const candidate = createCandidateAsset({
        type: "memory",
        learningScopeId: id,
        insightRevisionId: `irev:${i}`,
        statement: `repository marker ${i}`,
        guidance: `REPOSITORY_${i}_ONLY_MEMORY`,
        rationale: "owned fixture",
        evidenceRefs: [`fixture:${i}`],
        counterEvidenceRefs: [],
        applicability: { workerRoles: ["code"], taskTerms: ["marker"] },
        risk: "low",
      });
      candidate.lifecycle = "canary";
      candidate.evidenceGrade = "E3";
      await store.putCandidate(candidate);
      assets.push(candidate);
    }
    const service = new AgentTeamService({
      terminalSessionManager: h.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: h.options.ptyService,
      runtimeRegistry: h.options.runtimeRegistry,
      terminalStateService: h.options.terminalStateService,
      tmuxService: h.tmuxService,
      cwd: h.session.cwd,
      evolutionMemoryProvider: new DefaultEvolutionMemoryProvider(
        store,
        new StructuredEvolutionMemorySelector(),
      ),
    });
    try {
      for (let i = 0; i < locations.length; i++) {
        const now = new Date().toISOString(),
          runId = `atr_repo_${randomUUID()}`;
        const run = {
          runId,
          projectId: h.session.projectId,
          terminalSessionId: h.session.id,
          mainPanelId: h.panel.id,
          phase: "planning",
          status: "running",
          options: { flow: "code_first", reviewCheckpointMode: "disabled" },
          terminal: { command: binary, args: [], cwd: locations[i] },
          task: "Inspect repository marker; this is a controlled CLI probe.",
          verification: null,
          reviewCheckpoint: null,
          clarify: [],
          proposal: null,
          workers: [],
          acceptance: [],
          loop: createInitialLoop(3, 2),
          humanNotes: [],
          logs: [],
          createdAt: now,
          updatedAt: now,
        };
        await service.runStore.writeRun(run);
        const dispatched = await service.applySplit(
          run,
          [
            {
              id: `worker-${i}`,
              role: "code",
              intent: "Inspect repository marker",
              panelId: null,
              tmuxPaneId: null,
              frozen: false,
            },
          ],
          [],
          { source: "user", log: "repository integration dispatch" },
        );
        let observed = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            observed = JSON.parse(
              await readFile(
                path.join(locations[i], "worker-observed.json"),
                "utf8",
              ),
            );
            break;
          } catch {
            await delay(100);
          }
        }
        assert.ok(
          observed,
          JSON.stringify({
            phase: dispatched.phase,
            status: dispatched.status,
            logs: dispatched.logs,
          }),
        );
        assert.equal(
          observed.cwd,
          await (await import("node:fs/promises")).realpath(locations[i]),
        );
        const prompt = observed.args.at(-1);
        assert.ok(prompt.includes(runId));
        const traces = await store.listRuntimeTraces(runId);
        if (i < 2) {
          assert.ok(
            prompt.includes(`REPOSITORY_${i}_ONLY_MEMORY`),
            JSON.stringify({ prompt, traces }),
          );
          assert.ok(!prompt.includes(`REPOSITORY_${1 - i}_ONLY_MEMORY`));
          assert.equal(traces.length, 1);
          assert.deepEqual(traces[0].exposedRevisionIds, [
            assets[i].revisionId,
          ]);
          assert.equal(
            traces[0].dispatchId,
            dispatched.activeWorkerDispatch.dispatchId,
          );
        } else {
          assert.ok(!prompt.includes("<evolution-context"));
          assert.equal(traces.length, 0);
        }
        evidence.push({
          projectId: run.projectId,
          cwd: observed.cwd,
          pid: observed.pid,
          runId,
          dispatchId: dispatched.activeWorkerDispatch.dispatchId,
          exposedRevisionIds: traces[0]?.exposedRevisionIds ?? [],
          promptObservedInActualProcess: true,
        });
      }
    } finally {
      await service.dispose();
      await store.close();
    }
  });
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
