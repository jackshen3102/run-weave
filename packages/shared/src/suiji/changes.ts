/** Metadata only. Read current visible records and all followups before analysis. */
export type SuijiChange = {
  sequence: string;
  recordId: string;
  kind: "snapshot" | "record_changed" | "followup_added";
  actor: "app" | "agent";
  recordVersion: number;
  followupId: string | null;
  followupSequence: number | null;
  deleted: boolean;
  currentlyDeleted: boolean;
};
export type SuijiChangePage = {
  items: SuijiChange[];
  /** Always returned, including empty pages; persist after processing the page. */
  nextCursor: string;
  hasMore: boolean;
};
