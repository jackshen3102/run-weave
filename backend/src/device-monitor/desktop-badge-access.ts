import { createHash } from "node:crypto";
import { pushBadgeTargetIdentity } from "@runweave/shared/push-notifications";
import type { TerminalBadgeGatewayAccess, TerminalBadgeGatewayTargets } from "@runweave/shared/terminal-unread";
import type { AuthService } from "../auth/service";
import { DeviceSubscriptions, SubscriptionError } from "./subscriptions";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Borrows the existing subscription store and PushClient; owns no background resources. */
export class DesktopBadgeAccess {
  constructor(private auth: AuthService, private subscriptions: DeviceSubscriptions) {}

  targets(sessionId: string): TerminalBadgeGatewayTargets {
    const owner = this.auth.getActiveDesktopSession(sessionId);
    if (!owner) throw new SubscriptionError(403, "需要有效的桌面登录");
    const push = this.subscriptions.push;
    if (!push) throw new SubscriptionError(503, "此电脑尚未配置未读同步服务");
    const targets = Object.values(this.subscriptions.store.snapshot().subscriptions)
      .filter((s) => s.username === owner.username && s.kind === "terminal-unread" &&
        s.confirmed && this.subscriptions.valid(s) && this.subscriptions.isSynced(s))
      .map((s) => ({
        gatewayURL: push.url,
        targetId: digest(pushBadgeTargetIdentity(s.environment, s.installationId)),
        subscriptionId: s.id,
        environment: s.environment,
      }));
    return { targets };
  }

  async access(sessionId: string, subscriptionId: string): Promise<TerminalBadgeGatewayAccess> {
    const source = this.targets(sessionId).targets.find((s) => s.subscriptionId === subscriptionId);
    if (!source) throw new SubscriptionError(403, "未读同步来源不可访问");
    const push = this.subscriptions.push!;
    const readerId = digest(JSON.stringify([
      "badge-reader-v1", this.subscriptions.store.snapshot().hostId, sessionId, subscriptionId,
    ]));
    const access = await push.issueBadgeReader(readerId, subscriptionId);
    const current = this.targets(sessionId).targets.find((s) => s.subscriptionId === subscriptionId);
    if (this.subscriptions.push !== push || current?.gatewayURL !== source.gatewayURL ||
        current.targetId !== source.targetId) throw new SubscriptionError(409, "未读同步来源已变化");
    if (access.targetId !== source.targetId || access.readerId !== readerId ||
        typeof access.readToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(access.readToken) ||
        !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) {
      throw new SubscriptionError(502, "未读同步授权响应无效");
    }
    return { ...access, gatewayURL: source.gatewayURL };
  }
}
