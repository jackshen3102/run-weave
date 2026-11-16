import { z } from "zod";
import { QUALITY_ACTIONS, QUALITY_STAGES, QUALITY_LIMITS } from "@runweave/shared/quality-workflow";
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const time = z.string().datetime({ offset: true });
const metadata = z.string().regex(/^[a-zA-Z0-9._+ -]{1,128}$/);
export const eventSchema = z.object({
  seq: integer.positive(), at: time, action: z.enum(QUALITY_ACTIONS), stage: z.enum(QUALITY_STAGES),
  operationId: id, launchId: id, elapsedMs: integer, appVersion: metadata, buildId: metadata,
  sourceRevision: metadata, sourceState: z.enum(["clean", "modified", "unknown"]),
  terminalSessionId: id.optional(), attemptId: id.optional(), relatedOperationId: id.optional(),
  failureCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(), status: integer.max(999).optional(), closeCode: integer.max(65535).optional(),
}).strict();
export const rangeSchema = z.object({ from: integer.positive(), through: integer.positive(), reason: z.enum(["overflow", "corruption"]) }).strict().refine(v => v.through >= v.from);
export const batchSchema = z.object({ schemaVersion: z.literal(1), backendId: id, sourceId: id, streamId: id,
  client: z.enum(["desktop", "web", "ios", "backend"]), uploadedAt: time,
  events: z.array(eventSchema).max(QUALITY_LIMITS.batchEvents), droppedRanges: z.array(rangeSchema).max(128),
}).strict();
export const contextSchema = z.object({ schemaVersion: z.literal(1), backendId: id, readCursor: z.string().min(1).max(512),
  operations: z.array(z.object({ sourceId: id, launchId: id, action: z.enum(QUALITY_ACTIONS), operationId: id }).strict()).min(1).max(1000),
  after: integer.optional(), limit: integer.min(1).max(1000).optional(),
}).strict();
export const evidenceSchema = eventSchema.extend({ receiveId: integer.positive(), receivedAt: time, backendId: id, sourceId: id, streamId: id,
  client: z.enum(["desktop", "web", "ios", "backend"]), projectId: id.nullable() }).strict();
const evidenceIds = z.array(integer.positive()).max(1000);
const text = z.string().max(8000);
export const issueSchema = z.object({ issueId: id, groupKey: z.string().max(512), firstAt: time, lastAt: time,
  status: z.enum(["open", "observing", "awaiting_confirmation", "closed"]), attribution: z.enum(["located", "hypothesis"]),
  summary: text, cause: text, supporting: z.array(text).max(50), counterEvidence: z.array(text).max(50), gaps: z.array(text).max(50),
  impact: text, suggestion: text, nextAction: text, evidenceIds, fixVersion: metadata.nullable(), nextReviewAt: time.nullable(),
  verification: z.array(z.object({ at: time, version: metadata, result: text, evidenceIds }).strict()).max(100),
}).strict();
export const commitSchema = z.object({ schemaVersion: z.literal(1), backendId: id, runKey: id, commitKey: id, expectedRevision: integer,
  phase: z.enum(["acquire", "checkpoint", "analysis", "release", "recovery", "confirm_close"]), readCursor: z.string().max(512).optional(), analysisCursor: z.string().max(512).optional(),
  confirmedIssueIds: z.array(id).min(1).max(20).optional(),
  pending: z.array(evidenceSchema).max(1000).optional(), issues: z.array(issueSchema).max(20).optional(), summary: text.optional(),
}).strict();
