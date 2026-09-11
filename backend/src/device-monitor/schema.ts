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
    deviceToken: z.string(),
    displayName: z.string(),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    synced: z.boolean(),
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
        })
        .passthrough(),
    ),
    endedCycles: z.record(time).optional(),
    syncedCycles: z.record(z.boolean()).optional(),
  })
  .passthrough();
