import { randomUUID } from "node:crypto";
import type {
  DeviceNotificationRegistration,
  DeviceNotificationSubscription,
} from "@runweave/shared/device-notifications";
import type { AuthService } from "../auth/service";
import { PushClient, PushClientError } from "./push-client";
import type { DeviceMonitorStore } from "./store";
import type { DeviceSubscription } from "./types";
export class SubscriptionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class DeviceSubscriptions {
  onChange?: () => void;
  failure: string | null = null;
  constructor(
    readonly store: DeviceMonitorStore,
    readonly auth: AuthService,
    readonly push: PushClient | null,
  ) {}
  private owner(sessionId: string) {
    const owner = this.auth.getActiveAppSession(sessionId);
    if (!owner) throw new SubscriptionError(403, "需要有效的手机登录");
    return owner;
  }
  valid(value: DeviceSubscription): boolean {
    const owner = this.auth.getActiveAppSession(value.sessionId);
    return (
      value.enabled &&
      !!owner &&
      owner.username === value.username &&
      owner.connectionId === value.connectionId
    );
  }
  isSynced(value: DeviceSubscription): boolean {
    return !!this.push && value.gatewayURL === this.push.url && value.synced;
  }
  private dto(value: DeviceSubscription): DeviceNotificationSubscription {
    return {
      subscriptionId: value.id,
      hostId: this.store.snapshot().hostId,
      installationId: value.installationId,
      environment: value.environment,
      kind: value.kind ?? "battery",
      state: !value.enabled
        ? "disabled"
        : this.isSynced(value) && value.confirmed
          ? "enabled"
          : "pending",
      version: value.version,
      gatewayURL: this.push?.url ?? null,
      revokeToken:
        this.push && value.gatewayURL === this.push.url
          ? value.revokeToken
          : null,
    };
  }
  status(sessionId: string) {
    const owner = this.auth.getActiveAppSession(sessionId);
    if (!owner)
      return {
        available: false,
        reason: "请重新登录此电脑以开启提醒",
        subscriptions: [],
        supportedKinds: ["battery", "scheduled-task"],
      };
    const latest = new Map<string, DeviceSubscription>();
    for (const value of Object.values(this.store.snapshot().subscriptions)) {
      if (
        value.username === owner.username &&
        value.connectionId === owner.connectionId
      ) {
        const key = `${value.installationId}:${value.environment}:${value.kind ?? "battery"}`;
        if (!latest.get(key)?.enabled || value.enabled) latest.set(key, value);
      }
    }
    const targets = new Set(
      [...latest.values()]
        .filter((value) => (value.kind ?? "battery") === "battery")
        .map((value) => `${value.installationId}:${value.environment}`),
    );
    const last = Object.values(this.store.snapshot().deliveries)
      .filter((value) => targets.has(value.target))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const deliveryFailure =
      last?.state === "failed"
        ? "上次提醒发送失败，请检查推送配置或设备注册"
        : last?.state === "unknown"
          ? "上次提醒的投递结果未确认"
          : null;
    return {
      available: !!this.push,
      supportedKinds: ["battery", "scheduled-task"],
      reason: this.push
        ? (this.failure ?? deliveryFailure)
        : "此电脑尚未配置推送服务",
      subscriptions: [...latest.values()].map((value) => this.dto(value)),
    };
  }

  async register(
    sessionId: string,
    installationId: string,
    input: DeviceNotificationRegistration,
  ) {
    const owner = this.owner(sessionId);
    if (owner.connectionId !== input.connectionId)
      throw new SubscriptionError(403, "连接身份不匹配");
    if (!this.push) throw new SubscriptionError(503, "此电脑尚未配置推送服务");
    const kind = input.kind ?? "battery";
    if (!input.enabled) {
      await this.revoke(sessionId, installationId, kind);
      return null;
    }
    const value = await this.store.update((data) => {
      if (!this.auth.getActiveAppSession(sessionId))
        throw new SubscriptionError(401, "登录已失效");
      const existing = Object.values(data.subscriptions).find(
        (s) =>
          s.username === owner.username &&
          s.connectionId === owner.connectionId &&
          s.installationId === installationId &&
          s.environment === input.environment &&
          (s.kind ?? "battery") === kind &&
          s.enabled,
      );
      if (!existing && kind === "battery" && !input.explicitEnable)
        throw new SubscriptionError(409, "提醒已关闭，请手动重新开启");
      if (
        !existing &&
        Object.values(data.subscriptions).filter((s) => s.enabled).length >= 100
      )
        throw new SubscriptionError(429, "订阅数量已达上限");
      const next: DeviceSubscription = {
        id: existing?.id ?? randomUUID(),
        installationId,
        connectionId: owner.connectionId,
        sessionId,
        username: owner.username,
        environment: input.environment,
        kind,
        deviceToken: input.deviceToken,
        displayName: input.displayName,
        version: (existing?.version ?? 0) + 1,
        enabled: true,
        synced: false,
        gatewayURL: this.push!.url,
        confirmed:
          existing?.gatewayURL === this.push!.url
            ? (existing.confirmed ?? false)
            : false,
        confirmedAt:
          existing?.gatewayURL === this.push!.url
            ? existing.confirmedAt
            : undefined,
        revokeToken:
          existing?.gatewayURL === this.push!.url ? existing.revokeToken : null,
      };
      data.subscriptions[next.id] = next;
      return next;
    });
    await this.sync(value);
    this.onChange?.();
    return this.dto(this.store.snapshot().subscriptions[value.id]!);
  }
  async sync(value: DeviceSubscription): Promise<void> {
    if (!this.push) return;
    if (!this.valid(value)) {
      await this.disable(value.id);
      return;
    }
    // Persist the target and invalidate old acknowledgements before network I/O.
    // A failed attempt can retry the same version after restart.
    const gatewayURL = this.push.url;
    if (value.gatewayURL !== gatewayURL) {
      const rebound = await this.store.update((data) => {
        const current = data.subscriptions[value.id];
        if (
          !current ||
          !this.valid(current) ||
          current.version !== value.version
        )
          return null;
        current.gatewayURL = gatewayURL;
        current.version += 1;
        current.synced = false;
        current.confirmed = false;
        current.confirmedAt = undefined;
        current.revokeToken = null;
        return current;
      });
      if (!rebound) return;
      value = rebound;
    }
    try {
      const response = await this.push.register(value);
      this.failure = null;
      const revoke = await this.store.update((data) => {
        const current = data.subscriptions[value.id];
        if (!current || !this.valid(current)) return true;
        if (
          current.version === value.version &&
          current.gatewayURL === gatewayURL
        ) {
          current.synced = true;
          current.revokeToken = response.revokeToken;
        }
        return false;
      });
      if (revoke) await this.push.revoke(value.id);
    } catch (error) {
      this.failure = "推送暂不可用，注册待同步";
      if (
        error instanceof PushClientError &&
        (error.status === 409 || error.status === 410)
      ) {
        // A newer local token may have won; a stale version cannot disable that registration.
        const current = this.store.snapshot().subscriptions[value.id];
        if (current?.version === value.version) await this.disable(value.id);
      }
    }
  }
  async confirm(
    sessionId: string,
    installationId: string,
    id: string,
    version: number,
  ) {
    const owner = this.owner(sessionId);
    const value = await this.store.update((data) => {
      const current = data.subscriptions[id];
      if (
        !current ||
        !this.valid(current) ||
        current.username !== owner.username ||
        current.connectionId !== owner.connectionId ||
        current.installationId !== installationId ||
        current.version !== version ||
        !this.isSynced(current) ||
        !current.revokeToken
      ) {
        throw new SubscriptionError(409, "订阅已变化，请重新同步");
      }
      current.confirmed = true;
      current.confirmedAt ??= new Date().toISOString();
      return current;
    });
    this.onChange?.();
    return this.dto(value);
  }
  async disable(id: string): Promise<void> {
    await this.store.update((data) => {
      const s = data.subscriptions[id];
      if (s) {
        s.enabled = false;
        s.synced = false;
      }
    });
    try {
      if (!this.push) return;
      await this.push.revoke(id);
      await this.store.update((data) => {
        const s = data.subscriptions[id];
        if (s && !s.enabled) {
          s.synced = true;
          s.gatewayURL = this.push!.url;
          s.revokeToken = null;
          s.confirmed = false;
          s.deviceToken = "";
        }
      });
    } catch {
      this.failure = "推送暂不可用，关闭提醒待同步";
    }
  }
  async revoke(
    sessionId: string,
    installationId: string,
    kind: "battery" | "scheduled-task" = "battery",
  ): Promise<boolean> {
    const owner = this.owner(sessionId);
    const values = Object.values(this.store.snapshot().subscriptions).filter(
      (s) =>
        s.username === owner.username &&
        s.connectionId === owner.connectionId &&
        s.installationId === installationId &&
        (s.kind ?? "battery") === kind,
    );
    for (const value of values) await this.disable(value.id);
    this.onChange?.();
    return values.every(
      (s) => this.store.snapshot().subscriptions[s.id]?.synced,
    );
  }
  async reconcile(): Promise<void> {
    this.failure = null;
    for (const value of Object.values(this.store.snapshot().subscriptions)) {
      if (!this.valid(value)) {
        if (value.enabled || !value.synced) await this.disable(value.id);
      } else if (!this.isSynced(value)) await this.sync(value);
      if (this.failure) break; // One unreachable relay must not consume 100 sequential timeouts.
    }
  }
}
