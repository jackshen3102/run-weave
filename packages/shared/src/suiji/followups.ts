import type { SuijiAttachment } from "./attachments";

export type FollowupSource = {
  actor: "app" | "agent";
  agentName?: string;
  sessionId?: string;
};
export type SuijiFollowup = {
  id: string;
  recordId: string;
  sequence: number;
  body: string;
  createdAt: string;
  source: FollowupSource;
  attachments: SuijiAttachment[];
};
export type FollowupSummary = {
  count: number;
  latest: null | {
    id: string;
    sequence: number;
    excerpt: string;
    createdAt: string;
    source: FollowupSource;
  };
};
export type AppendFollowup = {
  body: string;
  attachmentIds?: string[];
  agentName?: string;
  sessionId?: string;
};
export type FollowupPage = {
  items: SuijiFollowup[];
  nextCursor: string | null;
};
export type FollowupResponse = {
  followup: SuijiFollowup;
  followupSummary: FollowupSummary;
};
export const emptyFollowupSummary = (): FollowupSummary => ({
  count: 0,
  latest: null,
});
export function latestFollowupSummary(
  a?: FollowupSummary,
  b?: FollowupSummary,
) {
  return (a?.latest?.sequence ?? 0) > (b?.latest?.sequence ?? 0) ? a : (b ?? a);
}
