export const ACTIVITY_SCHEMA_VERSION = 1 as const;
export const ACTIVITY_RETENTION_DAYS = {
  content: 7,
  fact: 30,
} as const;

export type ActivityRuntimeChannel = "stable" | "beta" | "dev" | "external";
export type ActivityRuntimeSurface =
  | "backend"
  | "desktop"
  | "web"
  | "app"
  | "cli"
  | "hook"
  | "shell";
export type ActivityActorType = "user" | "agent" | "system" | "unknown";
export type ActivityActorAgent =
  | "codex"
  | "claude"
  | "trae"
  | "playwright"
  | "other";
export type ActivityResultStatus = "succeeded" | "failed" | "cancelled";
export type ActivityPrivacyClassification =
  | "metadata"
  | "sensitive"
  | "restricted";
export type ActivityRetentionClass = "content_7d" | "fact_30d";
export type ActivityContentRole =
  | "query"
  | "response"
  | "command"
  | "tool_args"
  | "tool_result"
  | "excerpt";
export type ActivityExternalRefRole =
  | "thread"
  | "scrollback"
  | "run"
  | "outbox"
  | "evidence"
  | "artifact";
export type ActivityExternalRefAuthority =
  | "codex_thread"
  | "terminal_scrollback"
  | "agent_team_run"
  | "browser_artifact"
  | "verification_evidence";

export const ACTIVITY_EVENT_NAMES = [
  "producer.instance.started",
  "terminal.session.created",
  "terminal.session.deleted",
  "terminal.command.started",
  "terminal.command.completed",
  "user.query.submit_requested",
  "agent.thread.started",
  "agent.thread.resumed",
  "agent.lifecycle.observed",
  "agent.response.observed",
  "agent.tool.requested",
  "agent.tool.completed",
  "browser.tab.created",
  "browser.tab.activated",
  "browser.tab.closed",
  "browser.navigation.started",
  "browser.navigation.completed",
  "browser.navigation.failed",
  "browser.navigation.cancelled",
  "verification.started",
  "verification.completed",
  "agent_team.run.created",
  "agent_team.run.state_changed",
  "agent_team.run.completed",
  "agent_team.worker.dispatched",
  "agent_team.worker.result_recorded",
  "agent_team.case.dispatched",
  "agent_team.case.result_recorded",
  "source.events_dropped",
] as const;

export type ActivityEventName = (typeof ACTIVITY_EVENT_NAMES)[number];

export type ActivityPayloadValue =
  | string
  | number
  | boolean
  | null
  | ActivityPayloadValue[]
  | { [key: string]: ActivityPayloadValue };
export type ActivityPayload = Record<string, ActivityPayloadValue>;

export type AgentTeamActivityPurpose =
  | "run_lifecycle"
  | "initial_code"
  | "review"
  | "full_behavior"
  | "repair"
  | "protocol_correction"
  | "acceptance_result";

export type AgentTeamActivityReasonCode =
  | "run_created"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled"
  | "scope_decision_required"
  | "framework_repair_blocked"
  | "recovery_required"
  | "run_resumed"
  | "phase_and_status_changed"
  | "phase_changed"
  | "status_changed"
  | "protocol_correction_requested"
  | "repair_requested"
  | "review_requested"
  | "behavior_verification_requested"
  | "code_execution_requested"
  | "acceptance_case_dispatched"
  | "acceptance_passed"
  | "acceptance_failed"
  | "worker_result_failed"
  | "worker_result_completed";

export type AgentTeamActivityPayload = ActivityPayload & {
  transitionId: string;
  reasonCode: AgentTeamActivityReasonCode;
  purpose: AgentTeamActivityPurpose;
};

export interface ActivityScopeInput {
  cwd?: string;
  projectId?: string;
  terminalSessionId?: string;
  panelId?: string;
  tmuxPaneId?: string;
  threadId?: string;
  turnId?: string;
  interactionId?: string;
  runId?: string;
  operationId?: string;
  browserGroupId?: string;
  tabId?: string;
}

export interface ActivityContentInput {
  contentId: string;
  role: ActivityContentRole;
  mediaType: string;
  bytesBase64: string;
}

export interface ActivityExternalRefInput {
  refId: string;
  role: ActivityExternalRefRole;
  authority: ActivityExternalRefAuthority;
  locator: string;
  versionOrDigest: string;
  capturedAt: string;
  expectedExpiresAt?: string;
}

export interface ActivityEventInput<
  EventName extends ActivityEventName = ActivityEventName,
  Payload extends ActivityPayload = ActivityPayload,
> {
  eventId: string;
  eventName: EventName;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  occurredAt: string;
  producer: {
    name: string;
    version: string;
    instanceId: string;
    bootId: string;
    bootStartedAt: string;
    sequence: number;
  };
  actor: {
    type: ActivityActorType;
    agent?: ActivityActorAgent;
  };
  runtime: {
    channel: ActivityRuntimeChannel;
    surface: ActivityRuntimeSurface;
    appVersion?: string;
    sourceRevision?: string;
    backendProfileId?: string;
  };
  scope: ActivityScopeInput;
  correlationId?: string;
  causationId?: string;
  parentEventId?: string;
  result?: {
    status: ActivityResultStatus;
    code?: string;
  };
  payload: Payload;
  contents: ActivityContentInput[];
  externalRefs: ActivityExternalRefInput[];
}

export interface ActivityWriteAck {
  eventId: string;
  status: "committed" | "duplicate" | "rejected";
  activityOffset?: number;
  code?: string;
}

export interface ActivityBatchWriteResponse {
  acknowledgements: ActivityWriteAck[];
}

export interface ActivityFactDto {
  activityOffset: number;
  eventId: string;
  eventName: ActivityEventName;
  schemaVersion: number;
  occurredAt: string;
  ingestedAt: string;
  producer: {
    name: string;
    version: string;
    instanceId: string;
    bootId: string;
    sequence: number;
  };
  actor: { type: ActivityActorType; agent?: ActivityActorAgent };
  runtime: {
    channel: ActivityRuntimeChannel;
    surface: ActivityRuntimeSurface;
    appVersion?: string;
    sourceRevision?: string;
    backendProfileId?: string;
  };
  scope: ActivityScopeInput;
  correlationId?: string;
  causationId?: string;
  parentEventId?: string;
  result?: { status: ActivityResultStatus; code?: string };
  payload: ActivityPayload;
  privacyClassification: ActivityPrivacyClassification;
  retentionClass: ActivityRetentionClass;
  expiresAt: string;
  contentDescriptors: ActivityContentDescriptorDto[];
  externalRefDescriptors: ActivityExternalRefDescriptorDto[];
}

export interface ActivityContentDescriptorDto {
  contentId: string;
  role: ActivityContentRole;
  mediaType: string;
  byteLength: number;
  sha256: string;
  availability: "available" | "expired" | "deleted";
  expectedExpiresAt: string;
}

export interface ActivityContentValueDto extends ActivityContentDescriptorDto {
  eventId: string;
  bytesBase64?: string;
}

export interface ActivityExternalRefDescriptorDto {
  refId: string;
  role: ActivityExternalRefRole;
  authority: ActivityExternalRefAuthority;
  versionOrDigest: string;
  availability: "available" | "expired" | "missing" | "deleted";
}

export interface ActivityFactsQuery {
  runtimeChannel?: ActivityRuntimeChannel;
  runtimeSurface?: ActivityRuntimeSurface;
  projectId?: string;
  terminalSessionId?: string;
  threadId?: string;
  runId?: string;
  eventName?: ActivityEventName;
  actorType?: ActivityActorType;
  resultStatus?: ActivityResultStatus;
  search?: string;
  cursor?: string;
  asOfActivityOffset?: number;
  limit?: number;
}

export interface ActivityFactsPage {
  facts: ActivityFactDto[];
  asOfActivityOffset: number;
  nextCursor?: string;
  computed?: {
    eventCount: number;
    durationMs?: number;
  };
}

export type ActivityTimelineSelector =
  | { type: "interaction"; id: string }
  | { type: "correlation"; id: string }
  | { type: "thread"; id: string }
  | { type: "run"; id: string };

export interface ActivitySourceDto {
  producerInstanceId: string;
  producerBootId: string;
  producerName: string;
  producerVersion: string;
  runtimeChannel: ActivityRuntimeChannel;
  runtimeSurface: ActivityRuntimeSurface;
  firstSeenAt: string;
  lastSeenAt: string;
  highestSeenSequence: number;
  highestContiguousSequence: number;
  openGapCount: number;
  rejectionCount: number;
  gapRanges: Array<{
    firstSequence: number;
    lastSequence: number;
    status: "open" | "closed";
    reasonCode?: string;
  }>;
  lastCommitLatencyMs?: number;
  lastErrorCode?: string;
}

export interface ActivityDataPolicyDto {
  available: boolean;
  databasePathLabel: string;
  factRetentionDays: number;
  contentRetentionDays: number;
  databaseBytes: number;
  journalMode: string;
  schemaVersion: number;
  pendingDeleteJobs: number;
  lastCheckpointAt?: string;
  unavailableReason?: string;
}

export type ActivityOperationAction = "export" | "delete";
export type ActivityOperationScope =
  | { projectId: string; threadId?: never }
  | { threadId: string; projectId?: never };

export interface ActivityOperationRequest {
  action: ActivityOperationAction;
  scope: ActivityOperationScope;
}

export interface ActivityExportResponse {
  schemaVersion: 1;
  exportedAt: string;
  scope: ActivityOperationScope;
  asOfActivityOffset: number;
  facts: ActivityFactDto[];
}

export interface ActivityDeleteJobDto {
  deleteJobId: string;
  scope: ActivityOperationScope;
  asOfActivityOffset: number;
  status: "pending" | "running" | "blocked" | "completed";
  previewFactCount: number;
  deletedFactCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastErrorCode?: string;
}
