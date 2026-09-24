import type {
  ActivityEvolutionSnapshotQuery,
  ActivityFactsQuery,
  ActivityOperationScope,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import type { ActivityStore } from "../recording/store";
import { ACTIVITY_RETENTION_DAYS, type ActivityDataPolicyDto } from "@runweave/shared/activity";

export class ActivityQueryService {
  constructor(
    private readonly store: ActivityStore | null,
    private readonly unavailableReason = "activity_unavailable",
  ) {}

  private requireStore(): ActivityStore {
    if (!this.store) {
      throw new Error("activity_unavailable");
    }
    return this.store;
  }

  facts(query: ActivityFactsQuery) {
    return this.requireStore().facts(query);
  }

  evolutionSnapshot(query: ActivityEvolutionSnapshotQuery) {
    return this.requireStore().evolutionSnapshot(query);
  }

  evolutionEvidenceAvailability(eventIds: string[]) {
    return this.requireStore().evolutionEvidenceAvailability(eventIds);
  }

  timeline(selector: ActivityTimelineSelector, query: ActivityFactsQuery) {
    return this.requireStore().timeline(selector, query);
  }

  sources() {
    return this.requireStore().sources();
  }

  policy(): Promise<ActivityDataPolicyDto> {
    if (this.store) return this.store.policy();
    return Promise.resolve({
      available: false,
      contentStorage: "unavailable",
      contentUnavailableReason: this.unavailableReason,
      unavailableReason: this.unavailableReason,
      databasePathLabel: "~/.runweave/activity/activity.sqlite",
      factRetentionDays: ACTIVITY_RETENTION_DAYS.fact,
      contentRetentionDays: ACTIVITY_RETENTION_DAYS.content,
      databaseBytes: 0,
      journalMode: "unknown",
      schemaVersion: 0,
      pendingDeleteJobs: 0,
    });
  }

  preview(scope: ActivityOperationScope, asOfActivityOffset?: number) {
    return this.requireStore().preview(scope, asOfActivityOffset);
  }

  deleteStatus(deleteJobId: string) {
    return this.requireStore().deleteStatus(deleteJobId);
  }
}
