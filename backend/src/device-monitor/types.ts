import type { PushEnvironment } from "@runweave/shared/push-notifications";
import type { DeviceNotificationKind } from "@runweave/shared/device-notifications";
import type { TerminalPromptActionKind } from "@runweave/shared/terminal/questions";
import type { TerminalQuestionEnd, TerminalQuestionOrigin } from "../terminal/questions/origin";

export interface DeviceSubscription {
  id: string;
  installationId: string;
  connectionId: string;
  username: string;
  sessionId: string;
  environment: PushEnvironment;
  /** Missing on older battery subscriptions. */
  kind?: DeviceNotificationKind;
  confirmedAt?: string;
  deviceToken: string;
  displayName: string;
  version: number;
  enabled: boolean;
  synced: boolean;
  /** HTTPS origin this registration/version belongs to; absent on legacy records. */
  gatewayURL?: string;
  confirmed?: boolean;
  revokeToken: string | null;
}

export interface ScheduledTaskDelivery {
  id: string;
  runId: string;
  subscriptionId: string;
  notification: {
    category: "task.completed" | "task.failed";
    title: string;
    body: string;
    occurredAt: string;
    target?: { resourceType: "scheduled-run"; resourceId: string };
  };
  state:
    | "pending"
    | "sending"
    | "accepted"
    | "unknown"
    | "cancelled"
    | "failed";
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
}

export interface DeviceDelivery {
  id: string;
  cycleId: string;
  level: 10 | 20;
  target: string;
  state:
    | "pending"
    | "sending"
    | "accepted"
    | "unknown"
    | "cancelled"
    | "failed";
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  notification?: { title: string; body: string; occurredAt: string };
}

export interface TerminalQuestionPromptMeta {
  actionKind: TerminalPromptActionKind;
  title: string;
  body: string;
}

export interface DeviceMonitorData {
  terminalQuestions?: Record<string, TerminalQuestionLocation>;
  terminalQuestionPrompts?: Record<string, TerminalQuestionPromptMeta>;
  terminalReplies?: {
    inputs: Record<string, { id: string; hash: string; sessionId: string; subscriptionIds: string[]; expiresAt: number }[]>;
    turns: Record<string, { id: string; startEventId?: string; threadId: string | null; source: string; hash: string; sessionId: string | null; subscriptionIds: string[]; completed: boolean; startedAt: number }>;
    deliveries: Record<string, {
      id: string; terminalSessionId: string; panelId: string | null; sessionId: string; subscriptionId: string;
      notification: { title: string; body: string; occurredAt: string };
      state: "pending" | "sending" | "accepted" | "unknown" | "cancelled" | "failed";
      attempts: number; createdAt: number; nextAttemptAt: number;
    }>;
  };
  unread?: { revision: number; count: number };
  schemaVersion: 1;
  hostId: string;
  cycle: { id: string; highest: 10 | 20; startedAt: number } | null;
  endedCycles?: Record<string, number>;
  subscriptions: Record<string, DeviceSubscription>;
  deliveries: Record<string, DeviceDelivery>;
  taskDeliveries?: Record<string, ScheduledTaskDelivery>;
}

export interface TerminalQuestionLocation {
  eventId: string;
  origin: TerminalQuestionOrigin;
  endState?: TerminalQuestionEnd;
  createdAt: number;
  expiresAt: number;
  deliveries: Record<string, Pick<DeviceDelivery, "state" | "attempts" | "nextAttemptAt"> & {
    subscriptionId: string;
    sessionId: string;
  }>;
}
