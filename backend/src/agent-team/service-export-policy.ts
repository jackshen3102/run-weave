import type {
  AgentTeamExportOutbox,
  AgentTeamExportResponse,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import { normalizeOutboxFindingList } from "./service-acceptance-policy";

export function buildExportAcceptanceSummary(
  run: AgentTeamRun,
  outboxes: AgentTeamExportOutbox[],
): AgentTeamExportResponse["acceptanceSummary"] {
  const outboxesByCase = new Map<string, AgentTeamWorkerOutbox[]>();
  for (const item of outboxes) {
    const outbox = item.outbox;
    if (!outbox?.acceptanceResults) {
      continue;
    }
    for (const result of outbox.acceptanceResults) {
      const current = outboxesByCase.get(result.caseId) ?? [];
      current.push(outbox);
      outboxesByCase.set(result.caseId, current);
    }
  }
  return run.acceptance.map((item) => {
    const caseOutboxes = outboxesByCase.get(item.caseId) ?? [];
    return {
      caseId: item.caseId,
      status: item.status,
      evidenceCount: item.evidence.length,
      sourceRoles: Array.from(
        new Set(
          caseOutboxes
            .map((outbox) => outbox.role)
            .filter((role): role is string => Boolean(role)),
        ),
      ),
      remainingFindingCount: caseOutboxes.reduce(
        (sum, outbox) =>
          sum +
          normalizeOutboxFindingList(outbox.remainingFindings, "open").length,
        0,
      ),
      resolvedFindingCount: caseOutboxes.reduce(
        (sum, outbox) =>
          sum +
          normalizeOutboxFindingList(outbox.resolvedFindings, "resolved")
            .length,
        0,
      ),
    };
  });
}
