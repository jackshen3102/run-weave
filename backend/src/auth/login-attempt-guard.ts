export interface LoginAttemptIdentity {
  ip: string;
  username: string;
}

export interface LoginAttemptDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

type LoginAttemptScope = "ip" | "username" | "ipUsername";

interface LoginAttemptRule {
  id: string;
  scope: LoginAttemptScope;
  maxAttempts: number;
  windowMs: number;
  lockMs: number;
}

interface LoginAttemptBucket {
  count: number;
  windowExpiresAt: number;
  lockExpiresAt: number;
}

const MINUTE_MS = 60 * 1000;

const DEFAULT_ATTEMPT_RULES: LoginAttemptRule[] = [
  {
    id: "ip:1m",
    scope: "ip",
    maxAttempts: 30,
    windowMs: MINUTE_MS,
    lockMs: MINUTE_MS,
  },
  {
    id: "ip:10m",
    scope: "ip",
    maxAttempts: 100,
    windowMs: 10 * MINUTE_MS,
    lockMs: 15 * MINUTE_MS,
  },
];

const DEFAULT_FAILURE_RULES: LoginAttemptRule[] = [
  {
    id: "ip-username:5m",
    scope: "ipUsername",
    maxAttempts: 5,
    windowMs: 5 * MINUTE_MS,
    lockMs: MINUTE_MS,
  },
  {
    id: "ip-username:15m",
    scope: "ipUsername",
    maxAttempts: 8,
    windowMs: 15 * MINUTE_MS,
    lockMs: 5 * MINUTE_MS,
  },
  {
    id: "ip-username:30m",
    scope: "ipUsername",
    maxAttempts: 12,
    windowMs: 30 * MINUTE_MS,
    lockMs: 15 * MINUTE_MS,
  },
  {
    id: "username:15m",
    scope: "username",
    maxAttempts: 10,
    windowMs: 15 * MINUTE_MS,
    lockMs: 5 * MINUTE_MS,
  },
];

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function buildScopeValue(
  identity: LoginAttemptIdentity,
  scope: LoginAttemptScope,
): string {
  const username = normalizeUsername(identity.username);
  if (scope === "ip") {
    return identity.ip;
  }
  if (scope === "username") {
    return username;
  }
  return `${identity.ip}:${username}`;
}

function buildBucketKey(rule: LoginAttemptRule, identity: LoginAttemptIdentity): string {
  return `${rule.id}:${buildScopeValue(identity, rule.scope)}`;
}

function toDecision(retryAfterMs: number): LoginAttemptDecision {
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

export class LoginAttemptGuard {
  private readonly buckets = new Map<string, LoginAttemptBucket>();
  private nextCleanupAt = 0;

  constructor(
    private readonly attemptRules = DEFAULT_ATTEMPT_RULES,
    private readonly failureRules = DEFAULT_FAILURE_RULES,
    private readonly cleanupIntervalMs = MINUTE_MS,
  ) {}

  check(identity: LoginAttemptIdentity): LoginAttemptDecision {
    const now = Date.now();
    this.cleanupExpiredBuckets(now);
    return this.checkLocks(identity, now);
  }

  recordAttempt(identity: LoginAttemptIdentity): LoginAttemptDecision {
    const now = Date.now();
    this.cleanupExpiredBuckets(now);
    return this.hitRules(identity, this.attemptRules, now, "above-limit");
  }

  recordFailure(identity: LoginAttemptIdentity): void {
    const now = Date.now();
    this.cleanupExpiredBuckets(now);
    this.hitRules(identity, this.failureRules, now, "at-limit");
  }

  recordSuccess(identity: LoginAttemptIdentity): void {
    for (const rule of this.failureRules) {
      this.buckets.delete(buildBucketKey(rule, identity));
    }
  }

  private checkLocks(
    identity: LoginAttemptIdentity,
    now: number,
  ): LoginAttemptDecision {
    let retryAfterMs = 0;

    for (const rule of [...this.attemptRules, ...this.failureRules]) {
      const bucket = this.buckets.get(buildBucketKey(rule, identity));
      if (bucket && bucket.lockExpiresAt > now) {
        retryAfterMs = Math.max(retryAfterMs, bucket.lockExpiresAt - now);
      }
    }

    if (retryAfterMs > 0) {
      return toDecision(retryAfterMs);
    }
    return { allowed: true };
  }

  private hitRules(
    identity: LoginAttemptIdentity,
    rules: LoginAttemptRule[],
    now: number,
    lockMode: "at-limit" | "above-limit",
  ): LoginAttemptDecision {
    let retryAfterMs = 0;

    for (const rule of rules) {
      const key = buildBucketKey(rule, identity);
      const current = this.buckets.get(key);
      const bucket =
        current && current.windowExpiresAt > now
          ? current
          : { count: 0, windowExpiresAt: now + rule.windowMs, lockExpiresAt: 0 };

      bucket.count += 1;
      const shouldLock =
        lockMode === "at-limit"
          ? bucket.count >= rule.maxAttempts
          : bucket.count > rule.maxAttempts;
      if (shouldLock) {
        bucket.lockExpiresAt = Math.max(bucket.lockExpiresAt, now + rule.lockMs);
        retryAfterMs = Math.max(retryAfterMs, bucket.lockExpiresAt - now);
      }
      this.buckets.set(key, bucket);
    }

    if (retryAfterMs > 0) {
      return toDecision(retryAfterMs);
    }
    return { allowed: true };
  }

  private cleanupExpiredBuckets(now: number): void {
    if (now < this.nextCleanupAt) {
      return;
    }

    this.nextCleanupAt = now + this.cleanupIntervalMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowExpiresAt <= now && bucket.lockExpiresAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
