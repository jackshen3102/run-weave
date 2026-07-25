import { buildWorkerStartupPrompt } from "../../backend/src/agent-team/prompt-builders.ts";

export function verifyReviewStartupPromptUsesExplicitGate(check, run, worker) {
  const prompt = buildWorkerStartupPrompt({
    run,
    worker,
    acceptance: [run.acceptance[1]],
    outboxPath: ".runweave/outbox/review.json",
  });
  check(
    "repair-review-startup-prompt-uses-explicit-gate-id",
    prompt.includes("[AGT-REVIEW-GATE]") &&
      prompt.includes("禁止按文案关键词选择业务 Case") &&
      !prompt.includes("优先使用 Code Review/代码审查相关 caseId"),
    prompt,
  );
}
