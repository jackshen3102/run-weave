import type {
  ActivityFactsQuery,
  ActivityOperationScope,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import type { ActivityStore } from "./activity-store";

export class ActivityQueryService {
  constructor(private readonly store: ActivityStore | null) {}

  private requireStore(): ActivityStore {
    if (!this.store) {
      throw new Error("activity_unavailable");
    }
    return this.store;
  }

  facts(query: ActivityFactsQuery) {
    return this.requireStore().facts(query);
  }

  timeline(selector: ActivityTimelineSelector, query: ActivityFactsQuery) {
    return this.requireStore().timeline(selector, query);
  }

  sources() {
    return this.requireStore().sources();
  }

  policy() {
    return this.requireStore().policy();
  }

  preview(scope: ActivityOperationScope, asOfActivityOffset?: number) {
    return this.requireStore().preview(scope, asOfActivityOffset);
  }

  deleteStatus(deleteJobId: string) {
    return this.requireStore().deleteStatus(deleteJobId);
  }
}
