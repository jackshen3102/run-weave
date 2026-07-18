export type AgentTeamAcceptanceSkipCode =
  | "blocked_by_case"
  | "fail_fast"
  | "environment"
  | "not_applicable";

export interface AgentTeamAcceptanceSkip {
  code: AgentTeamAcceptanceSkipCode;
  blockerCaseIds?: string[];
  retryable: boolean;
  detail: string;
}

export interface AgentTeamAcceptanceDraft {
  caseId?: string | null;
  text: string;
  sourceCaseId?: string | null;
  sourceFilePath?: string | null;
  sourceHeading?: string | null;
  tags?: string[];
  dependsOn?: string[];
}
