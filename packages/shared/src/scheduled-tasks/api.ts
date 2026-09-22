import type {
  ScheduledTaskConfig,
  ScheduledExecutionPolicy,
  ScheduledTaskProvider,
  ScheduledTerminalBinding,
  TaskSchedule,
} from "./types";

export interface ScheduledTaskCapabilities {
  enabled: boolean;
  reason?: string;
  providers: Array<{
    provider: ScheduledTaskProvider;
    available: boolean;
    reason?: string;
    models?: string[];
    efforts?: string[];
    executionPolicies?: ScheduledExecutionPolicy[];
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
  parentProjectId?: string;
  projectId?: string;
  q?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}
export interface CreateScheduledTaskRequest extends ScheduledTaskConfig {
  enabled: boolean;
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
