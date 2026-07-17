import type {
  AgentTeamAcceptanceCase,
  AgentTeamOutboxFinding,
  AgentTeamRun,
} from "@runweave/shared/agent-team";

export function isTraceableProductCase(item: AgentTeamAcceptanceCase): boolean {
  return Boolean(
    item.sourceCaseId &&
    item.sourceFilePath &&
    !/code review|代码审查|code_review/i.test(item.text),
  );
}

export function findingCaseTraceabilityErrors(
  run: AgentTeamRun,
  finding: AgentTeamOutboxFinding,
): string[] {
  const impacts = finding.caseImpacts ?? [];
  if (impacts.length === 0) {
    return ["caseImpacts 为空"];
  }
  return impacts.flatMap((impact) => {
    const errors: string[] = [];
    const acceptanceCase = run.acceptance.find(
      (item) => item.caseId === impact.caseId,
    );
    if (!acceptanceCase) {
      errors.push(`${impact.caseId} 不存在`);
    } else if (!isTraceableProductCase(acceptanceCase)) {
      errors.push(`${impact.caseId} 不是可追溯产品 Case`);
    }
    if (!impact.summary.trim()) {
      errors.push(`${impact.caseId} 缺少影响说明`);
    }
    if (impact.evidence.length === 0) {
      errors.push(`${impact.caseId} 缺少影响证据`);
    }
    return errors;
  });
}
