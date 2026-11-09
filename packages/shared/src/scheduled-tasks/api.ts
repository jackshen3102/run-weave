import type {
  ScheduledTaskConfig,
  ScheduledExecutionPolicy,
  ScheduledTaskProvider,
  ScheduledTerminalBinding,
  TaskSchedule,
} from "./types";

export const TASK_CONTEXT_VERSION = 2;
export const TASK_CONTEXT_VERSION_HEADER = "X-Runweave-Task-Context-Version";
export const SCHEDULED_TASK_PROMPT_MAX_LENGTH = 12_000;

export interface ScheduledTaskCapabilities {
  taskContextVersion: 2;
  enabled: boolean;
  reason?: string;
  providers: Array<{
    provider: ScheduledTaskProvider;
    available: boolean;
    reason?: string;
    models?: string[];
    efforts?: string[];
    executionPolicies?: ScheduledExecutionPolicy[];
    continuation?: boolean;
  }>;
  limits: {
    maxConcurrentRuns: number;
    timeoutMs: number;
    maxOutputBytes: number;
  };
}
export interface ScheduledTaskPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ScheduledTaskFilter {
  q?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}
export interface StartQuickInputRunRequest {
  projectId: string;
  expectedInputUpdatedAt: string;
}
export interface QuickInputRunFilter {
  source: "quick-input";
  projectId?: string;
  finishedSince?: string;
  cursor?: string;
  limit?: number;
}
export interface CreateScheduledTaskRequest extends ScheduledTaskConfig {
  enabled: boolean;
}

/** Read-only validation result for the exact create or update request. */
export interface ScheduledTaskValidation {
  config: CreateScheduledTaskRequest;
  provider: ScheduledTaskProvider;
  enabled: boolean;
  nextRunAt: string | null;
  occurrences: string[];
  currentRevision: number | null;
}
export interface UpdateScheduledTaskRequest extends Omit<
  Partial<CreateScheduledTaskRequest>,
  "model" | "effort"
> {
  expectedRevision: number;
  /** null restores the provider default; absent fields are unchanged. */
  model?: string | null;
  effort?: string | null;
}
export interface SchedulePreviewRequest {
  schedule: TaskSchedule;
}
export interface SchedulePreviewResponse {
  now: string;
  occurrences: string[];
}
export interface ScheduledRunOutput {
  text: string;
  /** Opaque byte offset after text, including at EOF; text advances this cursor. */
  nextCursor: string;
  hasMore: boolean;
}
export interface OpenScheduledRunRequest {
  replaceRepurposedBinding?: boolean;
}
export interface OpenScheduledRunResponse extends ScheduledTerminalBinding {
  projectId: string;
  terminalUrl: string;
}
