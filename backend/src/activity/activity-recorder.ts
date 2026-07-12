import type {
  ActivityEventInput,
  ActivityWriteAck,
} from "@runweave/shared/activity";
import { logger } from "../logging";
import type { ActivityStore } from "./activity-store";

export class ActivityRecorder {
  constructor(private readonly store: ActivityStore | null) {}

  get available(): boolean {
    return this.store !== null;
  }

  async recordBatch(events: ActivityEventInput[]): Promise<ActivityWriteAck[]> {
    if (!this.store) {
      return events.map((event) => ({
        eventId: event.eventId,
        status: "rejected",
        code: "activity_unavailable",
      }));
    }
    try {
      return await this.store.record(events);
    } catch (error) {
      logger.warn("activity.record.failed", {
        component: "activity",
        message: "Activity recording failed without interrupting the source operation",
        eventIds: events.map((event) => event.eventId),
        error,
      });
      return events.map((event) => ({
        eventId: event.eventId,
        status: "rejected",
        code: error instanceof Error ? error.message : "activity_record_failed",
      }));
    }
  }

  record(event: ActivityEventInput): void {
    void this.recordBatch([event]);
  }
}
