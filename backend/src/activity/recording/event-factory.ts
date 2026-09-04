import crypto from "node:crypto";
import type {
  ActivityActorAgent,
  ActivityActorType,
  ActivityEventInput,
  ActivityEventName,
  ActivityPayload,
  ActivityRuntimeChannel,
  ActivityRuntimeSurface,
  ActivityScopeInput,
} from "@runweave/shared/activity";

export interface ActivityEventFactoryIdentity {
  producerName: string;
  producerVersion: string;
  producerInstanceId: string;
  runtimeChannel: ActivityRuntimeChannel;
  runtimeSurface: ActivityRuntimeSurface;
  appVersion?: string;
  sourceRevision?: string;
  backendProfileId?: string;
}

export class ActivityEventFactory {
  private readonly bootId = crypto.randomUUID();
  private readonly bootStartedAt = new Date().toISOString();
  private sequence = 0;

  constructor(private readonly identity: ActivityEventFactoryIdentity) {}

  create(params: {
    eventName: ActivityEventName;
    occurredAt?: string;
    actorType?: ActivityActorType;
    actorAgent?: ActivityActorAgent;
    scope?: ActivityScopeInput;
    payload?: ActivityPayload;
    result?: ActivityEventInput["result"];
    correlationId?: string;
    causationId?: string;
    parentEventId?: string;
  }): ActivityEventInput {
    return {
      eventId: crypto.randomUUID(),
      eventName: params.eventName,
      schemaVersion: 1,
      occurredAt: params.occurredAt ?? new Date().toISOString(),
      producer: {
        name: this.identity.producerName,
        version: this.identity.producerVersion,
        instanceId: this.identity.producerInstanceId,
        bootId: this.bootId,
        bootStartedAt: this.bootStartedAt,
        sequence: ++this.sequence,
      },
      actor: {
        type: params.actorType ?? "system",
        ...(params.actorAgent ? { agent: params.actorAgent } : {}),
      },
      runtime: {
        channel: this.identity.runtimeChannel,
        surface: this.identity.runtimeSurface,
        ...(this.identity.appVersion
          ? { appVersion: this.identity.appVersion }
          : {}),
        ...(this.identity.sourceRevision
          ? { sourceRevision: this.identity.sourceRevision }
          : {}),
        ...(this.identity.backendProfileId
          ? { backendProfileId: this.identity.backendProfileId }
          : {}),
      },
      scope: params.scope ?? {},
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
      ...(params.causationId ? { causationId: params.causationId } : {}),
      ...(params.parentEventId ? { parentEventId: params.parentEventId } : {}),
      ...(params.result ? { result: params.result } : {}),
      payload: params.payload ?? {},
      contents: [],
      externalRefs: [],
    };
  }
}
