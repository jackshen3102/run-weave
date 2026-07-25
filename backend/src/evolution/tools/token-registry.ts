import crypto from "node:crypto";

export interface EvolutionToolGrant {
  runId: string;
  attemptId: string;
  analystRole: string;
  allowedTools: string[];
  maxToolCalls: number;
  expiresAt: string;
}

export interface IssuedEvolutionToolGrant {
  token: string;
  grant: EvolutionToolGrant;
}

export class EvolutionToolTokenRegistry {
  private readonly grants = new Map<string, EvolutionToolGrant>();
  private readonly runToolCalls = new Map<string, number>();

  issue(
    input: Omit<EvolutionToolGrant, "expiresAt"> & {
      ttlMs: number;
      now?: Date;
    },
  ): IssuedEvolutionToolGrant {
    const token = crypto.randomBytes(32).toString("base64url");
    const grant: EvolutionToolGrant = {
      runId: input.runId,
      attemptId: input.attemptId,
      analystRole: input.analystRole,
      allowedTools: [...new Set(input.allowedTools)],
      maxToolCalls: input.maxToolCalls,
      expiresAt: new Date(
        (input.now ?? new Date()).getTime() + input.ttlMs,
      ).toISOString(),
    };
    this.grants.set(tokenDigest(token), grant);
    return { token, grant: cloneGrant(grant) };
  }

  resolve(token: string, now: Date = new Date()): EvolutionToolGrant | null {
    const digest = tokenDigest(token);
    const grant = this.grants.get(digest);
    if (!grant) return null;
    if (Date.parse(grant.expiresAt) <= now.getTime()) {
      this.grants.delete(digest);
      return null;
    }
    return cloneGrant(grant);
  }

  consume(
    token: string,
    tool: string,
    now: Date = new Date(),
  ): EvolutionToolGrant {
    const grant = this.resolve(token, now);
    if (!grant) throw new Error("evolution_mcp_token_invalid");
    if (!grant.allowedTools.includes(tool)) {
      throw new Error("evolution_mcp_tool_forbidden");
    }
    const used = this.runToolCalls.get(grant.runId) ?? 0;
    if (used >= grant.maxToolCalls) {
      throw new Error("evolution_mcp_tool_budget_exceeded");
    }
    this.runToolCalls.set(grant.runId, used + 1);
    return grant;
  }

  revokeAttempt(attemptId: string): void {
    this.revokeWhere((grant) => grant.attemptId === attemptId);
  }

  revokeRun(runId: string): void {
    this.revokeWhere((grant) => grant.runId === runId);
    this.runToolCalls.delete(runId);
  }

  clear(): void {
    this.grants.clear();
    this.runToolCalls.clear();
  }

  private revokeWhere(predicate: (grant: EvolutionToolGrant) => boolean): void {
    for (const [digest, grant] of this.grants) {
      if (predicate(grant)) this.grants.delete(digest);
    }
  }
}

function tokenDigest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cloneGrant(grant: EvolutionToolGrant): EvolutionToolGrant {
  return { ...grant, allowedTools: [...grant.allowedTools] };
}
