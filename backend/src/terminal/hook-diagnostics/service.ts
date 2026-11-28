import { createHmac, randomBytes } from "node:crypto";
import type {
  InboxLiveCheckResult,
  InboxLiveCheckState,
} from "@runweave/shared/knowledge-inbox";
import type { RuntimeStatusItem } from "@runweave/shared/runtime-status";
import { v4 as uuidv4 } from "uuid";

const RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEDUPE_MS = 60_000;
const MAX_EVENTS = 100;

export type HookDiagnosticSource =
  | "claude"
  | "codex"
  | "trae"
  | "traecli"
  | "traex"
  | "pi"
  | "agy"
  | "unknown";

interface ForeignAttribution {
  terminalSessionId: string;
  source: HookDiagnosticSource;
  expectedFingerprint: string;
  actualFingerprint: string;
  firstObservedAt: number;
  observedAt: number;
  count: number;
}

interface AcceptedAttribution {
  source: HookDiagnosticSource;
  observedAt: number;
}

/** In-memory diagnostic evidence only; it never owns Terminal or completion state. */
export class HookDiagnosticService {
  private readonly salt = randomBytes(32);
  private readonly foreign: ForeignAttribution[] = [];
  private readonly accepted = new Map<string, AcceptedAttribution>();

  recordForeign(input: {
    terminalSessionId: string;
    source: HookDiagnosticSource;
    expectedSession: string;
    actualSession: string;
    expectedSocket?: string;
    actualSocket?: string;
  }): void {
    const now = Date.now();
    this.prune(now);
    const expectedFingerprint = this.fingerprint(
      input.expectedSocket
        ? `${input.expectedSession}@${input.expectedSocket}`
        : input.expectedSession,
    );
    const actualFingerprint = this.fingerprint(
      input.actualSocket
        ? `${input.actualSession}@${input.actualSocket}`
        : input.actualSession,
    );
    for (let index = this.foreign.length - 1; index >= 0; index -= 1) {
      const current = this.foreign[index]!;
      if (now - current.observedAt > DEDUPE_MS) break;
      if (
        current.terminalSessionId === input.terminalSessionId &&
        current.source === input.source &&
        current.expectedFingerprint === expectedFingerprint &&
        current.actualFingerprint === actualFingerprint
      ) {
        current.observedAt = now;
        current.count += 1;
        if (index < this.foreign.length - 1) {
          this.foreign.splice(index, 1);
          this.foreign.push(current);
        }
        return;
      }
    }
    this.foreign.push({
      terminalSessionId: input.terminalSessionId,
      source: input.source,
      expectedFingerprint,
      actualFingerprint,
      firstObservedAt: now,
      observedAt: now,
      count: 1,
    });
    if (this.foreign.length > MAX_EVENTS) {
      this.foreign.splice(0, this.foreign.length - MAX_EVENTS);
    }
  }

  recordAccepted(
    terminalSessionId: string,
    source: HookDiagnosticSource,
  ): void {
    const now = Date.now();
    this.prune(now);
    this.accepted.delete(terminalSessionId);
    this.accepted.set(terminalSessionId, { source, observedAt: now });
    while (this.accepted.size > MAX_EVENTS) {
      const oldest = this.accepted.keys().next().value;
      if (oldest === undefined) break;
      this.accepted.delete(oldest);
    }
  }

  runtimeStatusItem(now = Date.now()): RuntimeStatusItem {
    const snapshot = this.snapshot(now);
    return {
      id: "backend.agent-toolchain.hook-attribution",
      capabilityId: "agent-toolchain",
      label: "Hook 会话归属",
      state:
        snapshot.state === "failed"
          ? "unhealthy"
          : snapshot.state === "passed"
            ? "healthy"
            : "checking",
      summary: snapshot.summary,
      observedAt: snapshot.observedAt,
      dependsOn: ["backend.process"],
      recovery: null,
      facts: snapshot.facts.map((fact) => ({
        ...fact,
        kind: "text" as const,
        copyable: false,
      })),
      navigation: null,
    };
  }

  liveCheckResult(now = Date.now()): InboxLiveCheckResult {
    const snapshot = this.snapshot(now);
    return {
      runId: uuidv4(),
      state: snapshot.state,
      observedAt: snapshot.observedAt,
      summary: snapshot.summary,
      facts: snapshot.facts,
      validForMs: DEDUPE_MS,
    };
  }

  private snapshot(now: number): {
    state: InboxLiveCheckState;
    summary: string;
    observedAt: number;
    facts: Array<{ id: string; label: string; value: string }>;
  } {
    this.prune(now);
    let latest: ForeignAttribution | undefined;
    for (let index = this.foreign.length - 1; index >= 0; index -= 1) {
      const candidate = this.foreign[index]!;
      const accepted = this.accepted.get(candidate.terminalSessionId);
      if (!accepted || accepted.observedAt < candidate.observedAt) {
        latest = candidate;
        break;
      }
    }
    if (latest) {
      return {
        state: "failed",
        summary: "最近发现 Hook 来自非受管 tmux session",
        observedAt: latest.observedAt,
        facts: [
          { id: "hook.source", label: "来源", value: latest.source },
          {
            id: "hook.count",
            label: "观察次数",
            value: String(latest.count),
          },
          {
            id: "hook.expected",
            label: "受管会话指纹",
            value: latest.expectedFingerprint,
          },
          {
            id: "hook.actual",
            label: "实际会话指纹",
            value: latest.actualFingerprint,
          },
        ],
      };
    }
    const accepted = Array.from(this.accepted.values()).sort(
      (left, right) => right.observedAt - left.observedAt,
    )[0];
    if (accepted) {
      return {
        state: "passed",
        summary: "最近 Hook 已通过受管会话归属校验",
        observedAt: accepted.observedAt,
        facts: [{ id: "hook.source", label: "来源", value: accepted.source }],
      };
    }
    return {
      state: "blocked",
      summary: "尚未观察到可判定的 Hook 会话归属",
      observedAt: now,
      facts: [],
    };
  }

  private prune(now: number): void {
    const cutoff = now - RETENTION_MS;
    while (this.foreign[0] && this.foreign[0].observedAt < cutoff) {
      this.foreign.shift();
    }
    for (const [terminalSessionId, value] of this.accepted) {
      if (value.observedAt < cutoff) this.accepted.delete(terminalSessionId);
    }
  }

  private fingerprint(value: string): string {
    return createHmac("sha256", this.salt)
      .update(value)
      .digest("hex")
      .slice(0, 12);
  }
}
