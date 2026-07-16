import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentTeamReviewCheckpointGit } from "../backend/src/agent-team/review-checkpoint-git.ts";
import {
  AGENT_TEAM_REVIEW_GATE_CASE_ID,
  ensureWorkerGateAcceptance,
  isReviewGateAcceptanceCase,
} from "../backend/src/agent-team/service-acceptance-policy.ts";
import { verifyRepairIntegration } from "./verify-agent-team-review-checkpoints/repair-integration.mjs";
import { verifyEvidenceGatedRepairLoop } from "./verify-agent-team-review-checkpoints/repair-loop.mjs";
import { verifyBootstrapLifecycle } from "./verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs";

const execFileAsync = promisify(execFile);
const checks = [];
const roots = [];

function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${JSON.stringify(detail)}`);
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

async function main() {
  const reviewWorker = { id: "review", role: "code_review", intent: "review" };
  const productCase = {
    caseId: "BSP-017",
    text: "stop/reset 后 warm 重试仍复用同一槽位",
    status: "pending",
    consecutiveFail: 0,
    evidence: [],
  };
  const acceptanceWithReviewGate = ensureWorkerGateAcceptance(
    [reviewWorker],
    [productCase],
  );
  check(
    "review-gate-uses-stable-reserved-case-id",
    acceptanceWithReviewGate.length === 2 &&
      acceptanceWithReviewGate[0]?.caseId === AGENT_TEAM_REVIEW_GATE_CASE_ID &&
      acceptanceWithReviewGate[1]?.caseId === "BSP-017",
    acceptanceWithReviewGate,
  );
  const acceptanceAfterProductCaseGrowth = ensureWorkerGateAcceptance(
    [reviewWorker],
    [productCase, { ...productCase, caseId: "BSP-018" }],
  );
  check(
    "review-gate-id-does-not-drift-with-product-case-count",
    acceptanceAfterProductCaseGrowth.length === 3 &&
      acceptanceAfterProductCaseGrowth[0]?.caseId ===
        AGENT_TEAM_REVIEW_GATE_CASE_ID &&
      acceptanceAfterProductCaseGrowth
        .slice(1)
        .map((item) => item.caseId)
        .join(",") === "BSP-017,BSP-018",
    acceptanceAfterProductCaseGrowth,
  );
  const legacyReviewGate = {
    ...acceptanceWithReviewGate[0],
    caseId: "case_17",
  };
  const acceptanceWithLegacyReviewGate = ensureWorkerGateAcceptance(
    [reviewWorker],
    [productCase, legacyReviewGate],
  );
  check(
    "legacy-numbered-review-gate-remains-recognized",
    isReviewGateAcceptanceCase(legacyReviewGate) &&
      acceptanceWithLegacyReviewGate.length === 2 &&
      acceptanceWithLegacyReviewGate[0] === legacyReviewGate &&
      acceptanceWithLegacyReviewGate[1] === productCase,
    acceptanceWithLegacyReviewGate,
  );

  await verifyBootstrapLifecycle(check, roots);
  verifyEvidenceGatedRepairLoop(check);
  await verifyRepairIntegration(check, createRepo);

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
  await service.assertCheckpointHead(state2, ["app.txt"]);
  check(
    "checkpoint-head-allows-explicit-agent-intervention-path",
    true,
    "explicit checkpoint path did not permit behavior dispatch",
  );
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
  await writeFile(path.join(root, "control-plane.txt"), "agent intervention\n");
  await git(root, ["add", "control-plane.txt"]);
  await git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@runweave.local",
    "commit",
    "-m",
    "control-plane update",
  ]);
  const interventionHead = await git(root, ["rev-parse", "HEAD"]);
  await service.assertCheckpointHead(
    state3,
    [],
    interventionHead,
    checkpoint2.commit,
  );
  check(
    "checkpoint-head-allows-explicit-descendant-agent-intervention-commit",
    true,
    interventionHead,
  );
  const interventionFinalTarget = await service.prepareReviewTarget({
    state: state3,
    scope: "final",
    planSha256: "plan-one",
    testCaseSha256: "cases-one",
    expectedHeadCommit: interventionHead,
    rebasedCheckpointCommit: checkpoint2.commit,
  });
  check(
    "final-review-target-allows-explicit-rebased-intervention-head",
    interventionFinalTarget.targetCommit === interventionHead &&
      interventionFinalTarget.changedPaths.includes("control-plane.txt"),
    interventionFinalTarget,
  );
  await service.assertReviewTargetUnchanged(state3, interventionFinalTarget);

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
