import { z } from "zod";
import type { SupervisionAssessment, SupervisionInput, TaskOutcome, TaskWatch, SupervisionDecisionSummary } from "@runweave/shared/task-supervision";

export const ASSESSMENT_POLICY_VERSION = "2026-10-17-evidence-progress-v7";
// Frozen on 40 synthetic calibration examples; scores are not correctness probabilities.
export const ASSESSMENT_THRESHOLDS = { minimumScore: 0.70, minimumMargin: 0.20 };
export const assessmentSchema = z.object({
  coverage: z.enum(["complete", "partial"]),
  criteria: z.array(z.object({
    text: z.string().trim().min(1).max(200),
    state: z.enum(["reported_done", "pending", "contradicted", "unknown", "waived"]),
    sourceMessageIds: z.array(z.string()).min(1).max(4),
    note: z.string().trim().min(1).max(200),
  }).strict()).max(24),
  missingEvidence: z.array(z.string().trim().min(1).max(200)).max(8),
  progress: z.object({
    previousDecisionId: z.string(),
    state: z.enum(["advanced", "no_new_evidence", "unknown"]),
    sourceMessageIds: z.array(z.string()).max(4),
    note: z.string().trim().min(1).max(200),
    alternativePath: z.string().trim().max(200),
  }).strict().nullable(),
}).strict();

export const assessmentInstructions = `
本轮额外输出 assessment，只核对报告，不执行独立验收。按当前目标和真实用户来源逐项列出必要完成条件，不能将 Agent 建议变成义务。每项 text/note 不超过200字，最多24项。超过容量或必要范围不明时 coverage=partial，并写明 missingEvidence，不假装完整覆盖。
状态：reported_done=报告说明完成且未被后续推翻；pending=必要工作明确未完成；contradicted=完成报告被新失败/用户纠正推翻；unknown=资料不足；waived=用户明确取消。每项给出所提供真实消息ID：reported_done 至少引用一条 Agent 报告，waived 至少引用用户来源。回答本身可以完成研究解释任务，不增加实现、发布或验收义务。
只有完整覆盖且所有条件 reported_done/waived 才选择 completed；分数是相对倾向，不是正确率。局部 unknown 不阻断有据的已授权独立下一步，选择 continue 并标出对应 pending 条件；只有全部剩余工作依赖外部条件且无独立步骤才 blocked。资料缺失且无法确定有效下一步时给 missingEvidence，不伪造外部依赖。
previousContinuation 是已消费的动作资料，不是新授权或事实，也不含历史评分。不存在该字段时 progress=null；存在时必须输出 progress，并原样引用 decisionId。advanced 需要当前报告中的必要新结果，单纯“已收到”不算。no_new_evidence 仅在报告明确未执行/重复汇报时使用；信息不足用 unknown。sourceMessageIds 至少含当前报告ID。alternativePath 仅填写资料支持的、不同于上次动作的具体可执行路径，否则空字符串；没有新路径不得把重复追问作为下一步。不要为了保持续接发明新工作。`;

export function assessClassification(input: SupervisionInput, output: {
  outcome: TaskOutcome; scores: Record<TaskOutcome, number>;
  guidance: { nextAction: string };
  assessment: z.infer<typeof assessmentSchema>;
}, thresholds = ASSESSMENT_THRESHOLDS): SupervisionAssessment {
  const raw = output.assessment;
  const messages = [input.task, ...input.userUpdates, ...input.recentExchanges, input.currentReply];
  const ids = new Set(messages.map((m) => m.id));
  const userIds = new Set([input.task, ...input.userUpdates].map((m) => m.id));
  const reportIds = new Set(messages.filter((m) => m.role === "assistant").map((m) => m.id));
  for (const row of raw.criteria) {
    if (row.sourceMessageIds.some((id) => !ids.has(id)) ||
      (row.state === "reported_done" && !row.sourceMessageIds.some((id) => reportIds.has(id))) ||
      (row.state === "waived" && !row.sourceMessageIds.some((id) => userIds.has(id))))
      throw new Error("完成条件引用了无效来源。");
  }
  const previous = input.previousContinuation;
  if (Boolean(previous) !== Boolean(raw.progress) || (raw.progress && (
    raw.progress.previousDecisionId !== previous?.decisionId ||
    !raw.progress.sourceMessageIds.includes(input.currentReply.id) ||
    raw.progress.sourceMessageIds.some((id) => !ids.has(id)))))
    throw new Error("进展比较与本轮已消费续接或报告来源不符。");
  const assessment: SupervisionAssessment = {
    version: 1, disposition: "apply", coverage: raw.coverage, criteria: raw.criteria,
    missingEvidence: raw.missingEvidence, ...(raw.progress ? { progress: raw.progress } : {}), thresholds,
  };
  const values = Object.values(output.scores).sort((a, b) => b - a);
  const incomplete = raw.criteria.some((row) => !["reported_done", "waived"].includes(row.state));
  const unfinished = raw.criteria.some((row) => ["pending", "contradicted", "unknown"].includes(row.state));
  if (raw.coverage !== "complete" || !raw.criteria.length ||
    (output.outcome === "completed" && (incomplete || raw.missingEvidence.length > 0)) ||
    (output.outcome === "continue" && !raw.criteria.some((row) => ["pending", "contradicted"].includes(row.state))) ||
    (output.outcome === "blocked" && (!unfinished || Boolean(output.guidance.nextAction)))) {
    assessment.holdReason = "evidence_gap";
  } else if (values[0]! < thresholds.minimumScore || values[0]! - values[1]! + 1e-9 < thresholds.minimumMargin || values[0] === values[1]) {
    assessment.holdReason = "ambiguous_scores";
  } else if (output.outcome === "continue" && raw.progress?.state === "no_new_evidence" && previous) {
    const normalize = (text: string) => text.replace(/\s+/g, "").trim();
    const different = normalize(output.guidance.nextAction) !== normalize(previous.nextAction);
    if (!raw.progress.alternativePath || !different) assessment.holdReason = "no_progress";
  }
  if (assessment.holdReason) assessment.disposition = "hold";
  if (Buffer.byteLength(JSON.stringify(assessment)) > 24 * 1024) throw new Error("完成条件核对超过 24 KiB；本次未自动续接。");
  return assessment;
}

/** Only the exact observed offer, in this task's source/goal/round, can be compared once. */
export function previousContinuation(watch: TaskWatch, previous: SupervisionDecisionSummary | undefined) {
  if (!previous || previous.decisionId === watch.lastComparedContinuationId || previous.delivery !== "observed" ||
    previous.assessment?.disposition === "hold" || previous.outcome !== "continue" ||
    previous.threadId !== watch.target.threadId || previous.contextRevision !== watch.contextRevision ||
    previous.goalVersion !== watch.goalDefinition?.version || !watch.sourceVersion || previous.sourceVersion !== watch.sourceVersion ||
    !previous.guidance?.nextAction) return undefined;
  const result = {
    decisionId: previous.decisionId, reportMessageId: previous.currentReplyId,
    remainingWork: previous.guidance.remainingWork, nextAction: previous.guidance.nextAction,
    authorizationMessageIds: previous.guidance.authorizationMessageIds, noProgressCount: watch.noProgressCount ?? 0,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024) throw new Error("上次续接资料超过 8 KiB，未静默截断。");
  return result;
}
