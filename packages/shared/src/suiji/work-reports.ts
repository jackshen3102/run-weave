import type { WorkDay } from "./work-records";

export type WorkReportInput = {
  from: string;
  to: string;
  title: string;
  body: string;
  basedOnFeedRevision: string;
  sourceFacts: { id: string; version: number }[];
  expectedVersion?: number;
};
export type WorkReport = Omit<WorkReportInput, "expectedVersion"> & {
  id: string;
  timeZone: "Asia/Shanghai";
  kind: "weekly";
  days: WorkDay[];
  version: number;
  manuallyEdited: boolean;
  createdAt: string;
  updatedAt: string;
};
export type WorkReportEdit = { title: string; body: string; expectedVersion: number };
