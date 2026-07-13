import { z } from "zod";
import {
  ACTIVITY_EVENT_NAMES,
  type ActivityEventInput,
  type ActivityEventName,
  type ActivityPrivacyClassification,
  type ActivityRuntimeSurface,
} from "@runweave/shared/activity";

export type ActivityIngress = "internal" | "hook" | "electron" | "shell";

interface ActivityEventDefinition {
  privacy: ActivityPrivacyClassification;
  priority: "critical" | "normal";
  allowedIngress: ActivityIngress[];
  allowedSurfaces: ActivityRuntimeSurface[];
}

const HOOK_EVENTS: ActivityEventName[] = [
  "user.query.submit_requested",
  "agent.thread.started",
  "agent.thread.resumed",
  "agent.lifecycle.observed",
  "agent.response.observed",
  "agent.tool.requested",
  "agent.tool.completed",
];
const ELECTRON_EVENTS: ActivityEventName[] = [
  "browser.tab.created",
  "browser.tab.activated",
  "browser.tab.closed",
  "browser.navigation.started",
  "browser.navigation.completed",
  "browser.navigation.failed",
  "browser.navigation.cancelled",
];
const SHELL_EVENTS: ActivityEventName[] = [
  "terminal.command.started",
  "terminal.command.completed",
];

function buildDefinition(eventName: ActivityEventName): ActivityEventDefinition {
  const allowedIngress: ActivityIngress[] = ["internal"];
  const allowedSurfaces: ActivityRuntimeSurface[] = ["backend"];
  if (HOOK_EVENTS.includes(eventName)) {
    allowedIngress.push("hook");
    allowedSurfaces.push("hook", "cli");
  }
  if (ELECTRON_EVENTS.includes(eventName)) {
    allowedIngress.push("electron");
    allowedSurfaces.push("desktop");
  }
  if (SHELL_EVENTS.includes(eventName)) {
    allowedIngress.push("shell");
    allowedSurfaces.push("shell", "cli");
  }
  return {
    allowedIngress,
    allowedSurfaces,
    privacy:
      HOOK_EVENTS.includes(eventName) || SHELL_EVENTS.includes(eventName)
        ? "sensitive"
        : "metadata",
    priority:
      eventName === "source.events_dropped" || eventName.endsWith("completed")
        ? "critical"
        : "normal",
  };
}

const ENABLED_ACTIVITY_EVENT_NAMES = ACTIVITY_EVENT_NAMES.filter(
  (eventName) => !eventName.startsWith("verification."),
);

export const activityEventRegistry = Object.fromEntries(
  ENABLED_ACTIVITY_EVENT_NAMES.map((eventName) => [eventName, buildDefinition(eventName)]),
) as Partial<Record<ActivityEventName, ActivityEventDefinition>>;

export function requireActivityEventDefinition(
  eventName: ActivityEventName,
): ActivityEventDefinition {
  const definition = activityEventRegistry[eventName];
  if (!definition) {
    throw new Error(`activity_event_not_registered:${eventName}`);
  }
  return definition;
}

const payloadValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(16_384),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(payloadValueSchema).max(128),
    z.record(z.string().max(128), payloadValueSchema),
  ]),
);

const activityEventSchema = z.object({
  eventId: z.string().uuid(),
  eventName: z.enum(ACTIVITY_EVENT_NAMES),
  schemaVersion: z.literal(1),
  occurredAt: z.string().datetime(),
  producer: z.object({
    name: z.string().min(1).max(80),
    version: z.string().min(1).max(80),
    instanceId: z.string().min(1).max(160),
    bootId: z.string().min(1).max(160),
    bootStartedAt: z.string().datetime(),
    sequence: z.number().int().positive(),
  }),
  actor: z.object({
    type: z.enum(["user", "agent", "system", "unknown"]),
    agent: z.enum(["codex", "claude", "trae", "playwright", "other"]).optional(),
  }),
  runtime: z.object({
    channel: z.enum(["stable", "beta", "dev", "external"]),
    surface: z.enum(["backend", "desktop", "web", "app", "cli", "hook", "shell"]),
    appVersion: z.string().max(80).optional(),
    sourceRevision: z.string().max(160).optional(),
    backendProfileId: z.string().max(160).optional(),
  }),
  scope: z.object({
    cwd: z.string().max(4096).optional(),
    projectId: z.string().max(256).optional(),
    terminalSessionId: z.string().max(256).optional(),
    panelId: z.string().max(256).optional(),
    tmuxPaneId: z.string().max(256).optional(),
    threadId: z.string().max(256).optional(),
    turnId: z.string().max(256).optional(),
    interactionId: z.string().max(256).optional(),
    runId: z.string().max(256).optional(),
    operationId: z.string().max(256).optional(),
    browserGroupId: z.string().max(256).optional(),
    tabId: z.string().max(256).optional(),
  }),
  correlationId: z.string().max(256).optional(),
  causationId: z.string().max(256).optional(),
  parentEventId: z.string().max(256).optional(),
  result: z
    .object({
      status: z.enum(["succeeded", "failed", "cancelled"]),
      code: z.string().max(160).optional(),
    })
    .optional(),
  payload: z.record(z.string().max(128), payloadValueSchema),
  contents: z
    .array(
      z.object({
        contentId: z.string().uuid(),
        role: z.enum(["query", "response", "command", "tool_args", "tool_result", "excerpt"]),
        mediaType: z.string().min(1).max(160),
        bytesBase64: z.string().max(11_184_812),
      }),
    )
    .max(16),
  externalRefs: z
    .array(
      z.object({
        refId: z.string().uuid(),
        role: z.enum(["thread", "scrollback", "run", "outbox", "evidence", "artifact"]),
        authority: z.enum(["codex_thread", "terminal_scrollback", "agent_team_run", "browser_artifact", "verification_evidence"]),
        locator: z.string().min(1).max(16_384),
        versionOrDigest: z.string().min(1).max(512),
        capturedAt: z.string().datetime(),
        expectedExpiresAt: z.string().datetime().optional(),
      }),
    )
    .max(16),
});

export function parseActivityEvents(
  value: unknown,
  ingress: ActivityIngress,
): ActivityEventInput[] {
  const body = z.object({ events: z.array(activityEventSchema).min(1).max(64) }).parse(value);
  return body.events.map((event) => {
    const definition = requireActivityEventDefinition(event.eventName);
    if (!definition.allowedIngress.includes(ingress)) {
      throw new Error(`activity_event_not_allowed:${event.eventName}:${ingress}`);
    }
    if (!definition.allowedSurfaces.includes(event.runtime.surface)) {
      throw new Error(`activity_surface_not_allowed:${event.eventName}:${event.runtime.surface}`);
    }
    return event as ActivityEventInput;
  });
}

export function listActivitySchemas(): Array<{
  eventName: ActivityEventName;
  schemaVersion: 1;
  privacyClassification: ActivityPrivacyClassification;
  allowedSurfaces: ActivityRuntimeSurface[];
}> {
  return ENABLED_ACTIVITY_EVENT_NAMES.map((eventName) => ({
    eventName,
    schemaVersion: 1,
    privacyClassification: requireActivityEventDefinition(eventName).privacy,
    allowedSurfaces: requireActivityEventDefinition(eventName).allowedSurfaces,
  }));
}
