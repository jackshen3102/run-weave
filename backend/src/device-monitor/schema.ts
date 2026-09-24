import { z } from "zod";
const environment = z.enum(["sandbox", "production"]);
const level = z.union([z.literal(10), z.literal(20)]);
const time = z.number().finite().nonnegative();
const subscription = z
  .object({
    id: z.string().uuid(),
    installationId: z.string().uuid(),
    connectionId: z.string(),
    username: z.string(),
    sessionId: z.string(),
    environment,
    kind: z.enum(["battery", "scheduled-task"]).optional(),
    confirmedAt: z.string().datetime().optional(),
    deviceToken: z.string(),
    displayName: z.string(),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    synced: z.boolean(),
    gatewayURL: z.string().url().optional(),
    confirmed: z.boolean().optional(),
    revokeToken: z.string().nullable(),
  })
  .passthrough();
export const deviceMonitorSchema = z
  .object({
    schemaVersion: z.literal(1),
    hostId: z.string().uuid(),
    cycle: z
      .object({ id: z.string().uuid(), highest: level, startedAt: time })
      .passthrough()
      .nullable(),
    subscriptions: z.record(subscription),
    deliveries: z.record(
      z
        .object({
          id: z.string(),
          cycleId: z.string().uuid(),
          level,
          target: z.string(),
          state: z.enum([
            "pending",
            "sending",
            "accepted",
            "unknown",
            "cancelled",
            "failed",
          ]),
          attempts: z.number().int().nonnegative(),
          createdAt: time,
          nextAttemptAt: time,
          notification: z
            .object({
              title: z.string(),
              body: z.string(),
              occurredAt: z.string().datetime(),
            })
            .strict()
            .optional(),
        })
        .passthrough(),
    ),
    taskDeliveries: z
      .record(
        z
          .object({
            id: z.string(),
            runId: z.string().uuid(),
            subscriptionId: z.string().uuid(),
            notification: z
              .object({
                category: z.enum(["task.completed", "task.failed"]),
                title: z.string(),
                body: z.string(),
                occurredAt: z.string().datetime(),
              })
              .strict(),
            state: z.enum([
              "pending",
              "sending",
              "accepted",
              "unknown",
              "cancelled",
              "failed",
            ]),
            attempts: z.number().int().nonnegative(),
            createdAt: time,
            nextAttemptAt: time,
          })
          .passthrough(),
      )
      .optional(),
    endedCycles: z.record(time).optional(),
  })
  .passthrough();
