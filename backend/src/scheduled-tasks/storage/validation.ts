import { z } from "zod";
import type {
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import { validateSchedule } from "../schedule";

const text = z.string().min(1);
const timestamp = z.string().datetime();
const provider = z.enum(["codex", "trae", "pi"]);
const schedule = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("daily"), timezone: text, localTime: text }),
    z.object({ kind: z.literal("weekdays"), timezone: text, localTime: text }),
    z.object({
      kind: z.literal("weekly"),
      timezone: text,
      localTime: text,
      weekdays: z.array(z.number().int()),
    }),
    z.object({ kind: z.literal("once"), timezone: text, runAt: timestamp }),
  ])
  .superRefine((value, ctx) => {
    try {
      validateSchedule(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid schedule",
      });
    }
  });
const config = z.object({
  name: text,
  projectId: text,
  provider,
  prompt: text,
  model: text.optional(),
  effort: text.optional(),
  executionPolicy: z.enum(["sandbox", "auto-review"]).optional(),
  schedule,
  misfirePolicy: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("skip") }),
    z.object({
      mode: z.literal("catch-up-latest"),
      maxDelaySeconds: z.number().int().positive().max(604800),
    }),
  ]),
});
const taskSchema: z.ZodType<ScheduledTask> = config.extend({
  id: text,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  nextRunAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});
const runSchema: z.ZodType<ScheduledRun> = z.object({
  id: text,
  taskId: text,
  taskRevision: z.number().int().positive(),
  snapshot: config,
  trigger: z.enum(["scheduled", "manual"]),
  scheduledFor: timestamp,
  dispatch: z
    .object({
      evaluatedAt: timestamp,
      latenessMs: z.number().finite().nonnegative(),
      catchUp: z.boolean(),
      coalescedFrom: timestamp.optional(),
    })
    .nullable(),
  status: z.enum([
    "queued",
    "running",
    "stopping",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ]),
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  summary: z.string().nullable(),
  outcome: z.enum(["succeeded", "blocked", "failed"]).optional(),
  error: z.object({ code: text, message: z.string() }).nullable(),
  artifacts: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(["link", "file", "text"]),
      url: z.string().optional(),
      text: z.string().optional(),
      fileRef: z.string().optional(),
    }),
  ),
  outputCursor: z.string().nullable(),
  executionProjectId: text,
  cwd: z.string(),
  threadRef: z
    .object({ provider, threadId: text, sessionFile: z.string().optional() })
    .nullable(),
  recoverable: z.boolean(),
  terminalBinding: z
    .object({
      terminalSessionId: text,
      panelId: text,
      attachmentState: z.enum(["creating", "starting", "ready", "failed"]),
      error: z.string().optional(),
    })
    .nullable(),
});

export interface StoredRow {
  id: string;
  payload_json: string;
  [key: string]: unknown;
}

export class InvalidScheduledRecord extends Error {
  constructor(
    readonly kind: "task" | "run",
    readonly recordId: string,
    readonly field: string,
  ) {
    super(`scheduled_record_invalid:${kind}:${recordId}:${field}`);
  }
}

function parse<T>(
  row: StoredRow,
  kind: "task" | "run",
  schema: z.ZodType<T>,
  columns: Record<string, string>,
): T {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new InvalidScheduledRecord(kind, row.id, "payload_json");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidScheduledRecord(
      kind,
      row.id,
      result.error.issues[0]?.path.join(".") || "payload_json",
    );
  }
  const fields = result.data as Record<string, unknown>;
  for (const [column, field] of Object.entries(columns)) {
    const expected =
      field === "enabled" ? Number(fields[field]) : fields[field];
    if (row[column] !== expected)
      throw new InvalidScheduledRecord(kind, row.id, field);
  }
  // Validate without rewriting or discarding stored extension fields.
  return value as T;
}

export function parseTask(row: StoredRow): ScheduledTask {
  return parse(row, "task", taskSchema, {
    id: "id",
    revision: "revision",
    project_id: "projectId",
    name: "name",
    enabled: "enabled",
    next_run_at: "nextRunAt",
    deleted_at: "deletedAt",
  });
}
export function parseRun(row: StoredRow): ScheduledRun {
  return parse(row, "run", runSchema, {
    id: "id",
    task_id: "taskId",
    status: "status",
    trigger_kind: "trigger",
    scheduled_for: "scheduledFor",
  });
}
