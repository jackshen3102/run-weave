import type {
  AgentTeamAcceptanceCase,
  AgentTeamLoop,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
} from "@runweave/shared";

export const DEFAULT_MAX_NO_PROGRESS = 3;
export const DEFAULT_STABLE_FAIL_THRESHOLD = 2;

export function createInitialLoop(): AgentTeamLoop {
  return {
    round: 1,
    noProgressCount: 0,
    maxNoProgress: DEFAULT_MAX_NO_PROGRESS,
    escalated: false,
    lastReason: null,
    stableFailThreshold: DEFAULT_STABLE_FAIL_THRESHOLD,
    errorFingerprints: [],
    bestPassCount: 0,
  };
}

/**
 * Normalize a failure into a coarse signature so "same error repeats" can be
 * detected. Starts conservative: strip digits, hex, paths, and collapse
 * whitespace; keep the human-readable original in evidence for review.
 */
export function fingerprintFailure(input: string): string {
  return input
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/([/~][\w./-]+)/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

interface FoldRoundResult {
  loop: AgentTeamLoop;
  acceptance: AgentTeamAcceptanceCase[];
  /** Case ids that just crossed the stable-fail threshold this round. */
  newlyStableFailCaseIds: string[];
  hadProgress: boolean;
}

/**
 * Fold one round's acceptance results into the run's loop + acceptance state,
 * applying debounce (single-round flip does not count) and objective progress
 * detection (pass count rising or a diff observed clears the counter).
 */
export function foldRound(
  run: AgentTeamRun,
  params: {
    acceptanceResults?: AgentTeamWorkerOutbox["acceptanceResults"];
    hadDiff?: boolean;
  },
): FoldRoundResult {
  const loop: AgentTeamLoop = { ...run.loop, errorFingerprints: [...run.loop.errorFingerprints] };
  const resultById = new Map(
    (params.acceptanceResults ?? []).map((result) => [result.caseId, result]),
  );

  const newlyStableFailCaseIds: string[] = [];
  const acceptance = run.acceptance.map((acceptanceCase) => {
    const result = resultById.get(acceptanceCase.caseId);
    if (!result) {
      return acceptanceCase;
    }
    if (result.status === "skipped") {
      return {
        ...acceptanceCase,
        lastRunStatus: "skipped" as const,
        skipReason: result.skipReason ?? "复验范围未命中，保持上一轮状态",
        evidence: result.evidence.length > 0 ? result.evidence : acceptanceCase.evidence,
      };
    }
    if (result.status === "pass") {
      return {
        ...acceptanceCase,
        status: "pass" as const,
        lastRunStatus: "pass" as const,
        skipReason: null,
        consecutiveFail: 0,
        evidence: result.evidence,
        bouncedToPanelId: null,
        recheckRequestedAt: null,
        recheckWorkerPanelId: null,
        recheckWorkerRole: null,
        recheckOutboxMtimeMs: null,
        recheckAttempt: 0,
      };
    }
    const consecutiveFail = acceptanceCase.consecutiveFail + 1;
    const nextCase: AgentTeamAcceptanceCase = {
      ...acceptanceCase,
      status: "fail",
      lastRunStatus: "fail",
      skipReason: null,
      consecutiveFail,
      evidence: result.evidence,
      recheckRequestedAt: null,
      recheckWorkerPanelId: null,
      recheckWorkerRole: null,
      recheckOutboxMtimeMs: null,
      recheckAttempt: 0,
    };
    // Only a stable-fail (>= threshold) counts as a real fail.
    if (
      consecutiveFail === loop.stableFailThreshold &&
      acceptanceCase.consecutiveFail < loop.stableFailThreshold
    ) {
      newlyStableFailCaseIds.push(acceptanceCase.caseId);
    }
    return nextCase;
  });

  const passCount = acceptance.filter((item) => item.status === "pass").length;
  const passRose = passCount > loop.bestPassCount;
  const hadProgress = passRose || Boolean(params.hadDiff);

  loop.round += 1;
  loop.bestPassCount = Math.max(loop.bestPassCount, passCount);
  if (hadProgress) {
    loop.noProgressCount = 0;
  } else if (params.hadDiff === false && resultById.size === 0) {
    loop.noProgressCount += 1;
  } else if (params.acceptanceResults && params.acceptanceResults.length > 0) {
    // Only count a no-progress round when there were real stable fails; a
    // single-round flip (consecutiveFail below threshold) does not increment.
    const stableFails = acceptance.filter(
      (item) =>
        item.status === "fail" &&
        item.consecutiveFail >= loop.stableFailThreshold,
    );
    if (stableFails.length > 0) {
      loop.noProgressCount += 1;
      // Record fingerprints for stable fails (evidence text as raw signal).
      for (const failure of stableFails) {
        const raw =
          failure.evidence.find((item) => item.type === "text")?.ref ??
          failure.text;
        const fingerprint = fingerprintFailure(raw);
        if (!loop.errorFingerprints.includes(fingerprint)) {
          loop.errorFingerprints.push(fingerprint);
        }
      }
    }
  }

  return { loop, acceptance, newlyStableFailCaseIds, hadProgress };
}

export function shouldEscalate(loop: AgentTeamLoop): boolean {
  return !loop.escalated && loop.noProgressCount >= loop.maxNoProgress;
}

export function buildEscalationReason(
  loop: AgentTeamLoop,
  acceptance: AgentTeamAcceptanceCase[],
): string {
  const stuckCases = acceptance
    .filter(
      (item) =>
        item.status === "fail" &&
        item.consecutiveFail >= loop.stableFailThreshold,
    )
    .map((item) => item.caseId);
  const casePart =
    stuckCases.length > 0
      ? `用例 ${stuckCases.join(", ")} 连续 ${loop.stableFailThreshold}+ 轮 fail`
      : "多轮无进展";
  const fingerprintPart =
    loop.errorFingerprints.length > 0
      ? `；错误指纹重复（${loop.errorFingerprints.length} 类）`
      : "";
  return `卡在 verify↔code 子循环：${casePart}${fingerprintPart}，连续 ${loop.noProgressCount} 轮无进展，自动熔断升级人工。`;
}
