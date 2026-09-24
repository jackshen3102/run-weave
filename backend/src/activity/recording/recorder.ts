import type {
  ActivityEventInput,
  ActivityWriteAck,
} from "@runweave/shared/activity";
import { logger } from "../../logging/index";
import type { ActivityStore } from "./store";

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
      const acknowledgements = await this.store.record(events);
      for (const ack of acknowledgements) {
        if (ack.status === "committed" && ack.code) {
          logger.warn("activity.content.omitted", {
            component: "activity", eventId: ack.eventId, code: ack.code,
            message: "Activity event saved without its content",
          });
        }
      }
      return acknowledgements;
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
