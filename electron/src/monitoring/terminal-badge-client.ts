import type { PushBadgeTotal } from "@runweave/shared/push-notifications";
import type { TerminalBadgeConnection, TerminalBadgeGatewayAccess, TerminalBadgeGatewayTarget, TerminalBadgeGatewayTargets, TerminalBadgeStatus } from "@runweave/shared/terminal-unread";

type Source = { connection: TerminalBadgeConnection; target: TerminalBadgeGatewayTarget };
type Access = { source: Source; value: TerminalBadgeGatewayAccess };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const key = (target: TerminalBadgeGatewayTarget) => target.gatewayURL + ":" + target.targetId;
const origin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid badge origin");
  return url.origin;
};
class BadgeRequestError extends Error {
  constructor(readonly status: number) { super("未读同步暂不可用"); }
}

/** Main-process only. No gateway credentials or transport errors reach the renderer. */
export class TerminalBadgeClient {
  private connections: TerminalBadgeConnection[] = [];
  private sources: Source[] = [];
  private access: Access | null = null;
  private boundKey: string | null = null;
  private snapshot: PushBadgeTotal | null = null;
  private status: TerminalBadgeStatus = { state: "unavailable", count: null, lastSyncedAt: null, reason: "登录电脑后同步未读数" };
  private generation = 0;
  private controller = new AbortController();
  private flight: Promise<void> | null = null;
  private stopped = false;
  private rediscoverAt = 0;
  private retryAt = 0;
  private failures = 0;
  private renewAt = 0;
  private renewalFailures = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private fetcher: Fetch, private display: (count: number | null) => void, private now = Date.now) {}
  getStatus(): TerminalBadgeStatus { return { ...this.status }; }

  setConnections(values: TerminalBadgeConnection[]): void {
    const next = values.filter((c) => c.url && c.token).sort((a, b) => a.id.localeCompare(b.id));
    if (this.stopped || JSON.stringify(next) === JSON.stringify(this.connections)) return;
    const retained = next.some((c) => this.connections.some((old) => old.id === c.id && old.url === c.url && old.token === c.token));
    this.generation++;
    clearTimeout(this.timer);
    this.controller.abort();
    this.controller = new AbortController();
    this.connections = next;
    this.sources = [];
    this.access = null;
    this.rediscoverAt = this.retryAt = this.failures = 0;
    this.renewAt = this.renewalFailures = 0;
    if (!retained) {
      this.boundKey = null;
      this.snapshot = null;
      this.status = { state: "unavailable", count: null, lastSyncedAt: null, reason: null };
      this.display(null);
    }
    this.setState(next.length ? "discovering" : "unavailable", next.length ? "正在同步未读数" : "登录电脑后同步未读数");
    this.tick();
  }
  dispose(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.controller.abort();
    this.connections = [];
    this.sources = [];
    this.access = null;
  }
  private setState(state: TerminalBadgeStatus["state"], reason: string | null): void { this.status = { ...this.status, state, reason }; }
  private current(generation: number): boolean { return !this.stopped && this.generation === generation; }
  private async request<T>(url: string, token: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await this.fetcher(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (!response.ok) throw new BadgeRequestError(response.status);
    return await response.json() as T;
  }
  private tick(): void {
    if (this.stopped || this.flight || !this.connections.length) return;
    if (this.now() < this.retryAt) { this.schedule(); return; }
    const generation = this.generation;
    this.retryAt = this.now() + 2_000;
    this.flight = this.sync(generation, this.controller.signal).catch((error: unknown) => {
      if (!this.current(generation)) return;
      this.failures++;
      this.retryAt = this.now() + Math.min(30_000, 2_000 * 2 ** Math.min(this.failures - 1, 4));
      const reason = error instanceof BadgeRequestError && [404, 405].includes(error.status) ? "未读同步服务尚未支持此功能"
        : error instanceof BadgeRequestError && error.status === 409 ? "等待未读数量同步" : "未读同步暂不可用，正在重试";
      this.setState(this.snapshot ? "stale" : "unavailable", reason);
    }).finally(() => {
      this.flight = null;
      this.schedule();
    });
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped || !this.connections.length) return;
    this.timer = setTimeout(() => this.tick(), Math.max(0, this.retryAt - this.now()));
    this.timer.unref();
  }
  private async discover(generation: number, signal: AbortSignal): Promise<void> {
    const results = await Promise.allSettled(this.connections.map(async (connection): Promise<Source[]> => {
      const result = await this.request<TerminalBadgeGatewayTargets>(connection.url + "/api/terminal/unread/gateway-targets", connection.token!, signal);
      if (!Array.isArray(result.targets) || result.targets.length > 100) throw new Error("Invalid badge targets");
      return result.targets.map((target) => {
        if (!target || typeof target.gatewayURL !== "string" || !/^[a-f0-9]{64}$/.test(target.targetId) ||
            typeof target.subscriptionId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(target.subscriptionId) ||
            !["sandbox", "production"].includes(target.environment)) throw new Error("Invalid badge target");
        return { connection, target: { ...target, gatewayURL: origin(target.gatewayURL) } };
      });
    }));
    if (!this.current(generation)) return;
    this.sources = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
    this.rediscoverAt = results.some((r) => r.status === "rejected" || !r.value.length) ? this.now() + 30_000 : Infinity;
    const targets = new Set(this.sources.map((s) => key(s.target)));
    if (targets.size > 1 || targets.size === 1 && this.boundKey !== null && !targets.has(this.boundKey)) {
      this.access = null;
      this.rediscoverAt = this.now() + 30_000;
      this.setState("conflict", "存在多个未读汇总来源");
      return;
    }
    if (!targets.size) {
      this.access = null;
      const unsupported = results.some((r) => r.status === "rejected" && r.reason instanceof BadgeRequestError && [404, 405].includes(r.reason.status));
      this.setState(this.snapshot ? "stale" : "unavailable", unsupported ? "未读同步服务尚未支持此功能" : "未读同步尚未就绪，正在重试");
      return;
    }
    this.boundKey = key(this.sources[0]!.target);
    if (this.access && !this.sources.some((s) => s.connection.id === this.access!.source.connection.id && s.target.subscriptionId === this.access!.source.target.subscriptionId)) this.access = null;
    this.setState(this.snapshot ? "stale" : "discovering", "正在同步未读数");
  }
  private async authorize(generation: number, signal: AbortSignal): Promise<void> {
    let failure: unknown = new Error("No badge source");
    for (const source of this.sources) {
      try {
        const value = await this.request<TerminalBadgeGatewayAccess>(source.connection.url + "/api/terminal/unread/gateway-access", source.connection.token!, signal, { subscriptionId: source.target.subscriptionId });
        if (!this.current(generation)) return;
        if (value.targetId !== source.target.targetId || origin(value.gatewayURL) !== source.target.gatewayURL ||
            typeof value.readerId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.readerId) ||
            typeof value.readToken !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(value.readToken) ||
            !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= this.now()) throw new Error("Invalid badge authorization");
        this.access = { source, value };
        this.renewAt = Date.parse(value.expiresAt) - 60_000;
        this.renewalFailures = 0;
        return;
      } catch (error) {
        if (!this.current(generation)) return;
        failure = error;
      }
    }
    if (this.access && Date.parse(this.access.value.expiresAt) > this.now()) {
      this.renewalFailures++;
      this.renewAt = this.now() + Math.min(30_000, 2_000 * 2 ** Math.min(this.renewalFailures - 1, 4));
      return;
    }
    this.access = null;
    this.rediscoverAt = 0;
    throw failure;
  }
  private async sync(generation: number, signal: AbortSignal): Promise<void> {
    if (this.now() >= this.rediscoverAt) await this.discover(generation, signal);
    if (!this.current(generation)) return;
    if (!this.sources.length || this.status.state === "conflict") { this.retryAt = this.rediscoverAt; return; }
    if (!this.access || Date.parse(this.access.value.expiresAt) <= this.now() || this.now() >= this.renewAt) await this.authorize(generation, signal);
    if (!this.current(generation) || !this.access) return;
    const access = this.access;
    let value: PushBadgeTotal;
    try {
      value = await this.request<PushBadgeTotal>(access.value.gatewayURL + "/v1/badge-readers/" + access.value.readerId, access.value.readToken, signal);
    } catch (error) {
      if (this.current(generation) && error instanceof BadgeRequestError && [401, 403, 410].includes(error.status)) {
        this.access = null;
        this.rediscoverAt = 0;
      }
      throw error;
    }
    if (!this.current(generation) || this.access !== access) return;
    if (value.targetId !== access.value.targetId || !Number.isSafeInteger(value.count) || value.count < 0 ||
        !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid badge snapshot");
    if (this.snapshot && (value.revision < this.snapshot.revision || value.revision === this.snapshot.revision && value.count !== this.snapshot.count)) throw new Error("Outdated badge snapshot");
    this.snapshot = value;
    this.failures = 0;
    this.status = { state: "ready", count: value.count, lastSyncedAt: new Date(this.now()).toISOString(), reason: null };
    this.display(value.count);
  }
}
