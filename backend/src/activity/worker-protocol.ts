import type {
  ActivityDataPolicyDto,
  ActivityContentValueDto,
  ActivityDeleteJobDto,
  ActivityEventInput,
  ActivityFactDto,
  ActivityFactsPage,
  ActivityFactsQuery,
  ActivityOperationScope,
  ActivitySourceDto,
  ActivityTimelineSelector,
  ActivityWriteAck,
} from "@runweave/shared/activity";
import type { ActivityMembershipSnapshot } from "./database-maintenance";
import type { ActivityIngestRejectionInput } from "./database-rejection";

export type ActivityWorkerRequest =
  | { id: number; op: "record"; events: ActivityEventInput[]; nowMs?: number }
  | { id: number; op: "facts"; query: ActivityFactsQuery }
  | {
      id: number;
      op: "timeline";
      selector: ActivityTimelineSelector;
      query: ActivityFactsQuery;
    }
  | { id: number; op: "sources" }
  | { id: number; op: "policy" }
  | { id: number; op: "content"; contentId: string }
  | { id: number; op: "audit-subject-hmac"; subject: string }
  | ({ id: number; op: "rejection" } & ActivityIngestRejectionInput)
  | {
      id: number;
      op: "audit";
      requestId: string;
      backendInstanceId: string;
      authSubjectHmac: string;
      action: "content_read" | "export";
      scopeJson: string;
      resultStatus: "succeeded" | "failed";
      resultCode?: string;
      nowMs?: number;
    }
  | { id: number; op: "preview"; scope: ActivityOperationScope; asOfActivityOffset?: number }
  | {
      id: number;
      op: "export-snapshot";
      scope: ActivityOperationScope;
      asOfActivityOffset: number;
    }
  | {
      id: number;
      op: "create-delete-job";
      requestId: string;
      backendInstanceId: string;
      authSubjectHmac: string;
      scope: ActivityOperationScope;
      snapshot: ActivityMembershipSnapshot;
      nowMs?: number;
    }
  | { id: number; op: "delete-status"; deleteJobId: string }
  | { id: number; op: "run-delete"; ownerId: string; nowMs?: number }
  | { id: number; op: "run-retention"; ownerId: string; nowMs?: number }
  | { id: number; op: "integrity" }
  | { id: number; op: "close" };

export type ActivityWorkerCommand = ActivityWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export type ActivityWorkerResult =
  | ActivityWriteAck[]
  | ActivityFactsPage
  | ActivitySourceDto[]
  | ActivityDataPolicyDto
  | ActivityContentValueDto
  | ActivityMembershipSnapshot
  | ActivityDeleteJobDto
  | ActivityDeleteJobDto
  | ActivityFactDto
  | ActivityFactDto[]
  | number
  | string
  | boolean
  | undefined
  | null;

export type ActivityWorkerResponse =
  | { id: number; ok: true; result: ActivityWorkerResult }
  | { id: number; ok: false; error: string };
