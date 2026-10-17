import type { SupervisionAssessment } from "@runweave/shared/task-supervision";

const states = { reported_done: "据报告完成", pending: "尚未完成", contradicted: "存在矛盾", unknown: "资料不足", waived: "用户已取消" };
export function SupervisionAssessmentDetails({ assessment }: { assessment?: SupervisionAssessment }) {
  if (!assessment) return <p>旧策略，未逐项核对。</p>;
  return <section className="space-y-3" aria-label="完成条件核对">
    <h3>完成条件核对 · {assessment.disposition === "hold" ? "暂缓采用判断" : "已采用判断"}</h3>
    <p>依据原会话报告核对，不构成独立验收。{assessment.coverage === "partial" ? "当前条件覆盖不完整。" : ""}</p>
    {assessment.missingEvidence.map((text, index) => <p key={index} className="text-amber-300">待核对：{text}</p>)}
    {assessment.criteria.map((row, index) => <article key={index} className="space-y-1 rounded border border-slate-800 p-3">
      <p className="text-slate-200">{states[row.state]} · {row.text}</p>
      <p>{row.note}</p><p className="break-all">来源：{row.sourceMessageIds.join("、")}</p>
    </article>)}
    {assessment.progress && <p>续接后报告：{assessment.progress.state === "advanced" ? "有新进展" : assessment.progress.state === "no_new_evidence" ? "未观察到新进展" : "进展资料不足"} · {assessment.progress.note}</p>}
  </section>;
}
