import { randomUUID } from "node:crypto";
import type {
  InboxItem,
  InboxLiveCheckDescriptor,
  InboxLiveCheckResult,
} from "@runweave/shared/knowledge-inbox";
import type { AgentToolchainService } from "../agent-toolchain/service";
import type { HookDiagnosticService } from "../terminal/hook-diagnostics/service";

type ProbeId =
  | "toolkit-cache-consistency"
  | "hook-session-attribution";

const PROBES: Readonly<Record<string, ProbeId>> = {
  "skill-source-cache-content-verification": "toolkit-cache-consistency",
  "runweave-hook-foreign-tmux-session-attribution": "hook-session-attribution",
};

const MAX_CACHED_RESULTS = 200;

/** Static registry only. Inbox content never supplies a probe or its inputs. */
export class KnowledgeInboxLiveCheckService {
  private readonly latest = new Map<string, InboxLiveCheckResult>();

  constructor(
    private readonly toolchain: AgentToolchainService,
    private readonly hookDiagnostics: HookDiagnosticService,
  ) {}

  descriptor(
    item: InboxItem,
    executable: boolean,
  ): InboxLiveCheckDescriptor | undefined {
    if (item.source !== "experience" || !executable) return undefined;
    const supported = PROBES[item.sourceId] !== undefined;
    const now = Date.now();
    const last = this.latest.get(this.key(item));
    const lastResult =
      last && last.observedAt + last.validForMs > now ? last : undefined;
    return {
      supported,
      mode: "read-only",
      capabilityId: "agent-toolchain",
      itemId: item.itemId,
      ...(lastResult ? { lastResult } : {}),
    };
  }

  decorate(item: InboxItem, executable: boolean): InboxItem {
    const liveCheck = this.descriptor(item, executable);
    return liveCheck ? { ...item, liveCheck } : item;
  }

  async run(item: InboxItem): Promise<InboxLiveCheckResult> {
    const probe =
      item.source === "experience" ? PROBES[item.sourceId] : undefined;
    if (!probe) {
      return this.remember(
        item,
        result("unsupported", "此经验暂无内置现场复验", 60_000),
      );
    }
    const root = await this.toolchain.resolveRepositoryRoot(item.repositoryId);
    if (!root) {
      return this.remember(
        item,
        result("blocked", "所属仓库当前不可用", 15_000),
      );
    }
    const checked =
      probe === "toolkit-cache-consistency"
        ? await this.toolchain.toolkit()
        : this.hookDiagnostics.liveCheckResult();
    return this.remember(item, checked);
  }

  private remember(
    item: InboxItem,
    value: InboxLiveCheckResult,
  ): InboxLiveCheckResult {
    const now = Date.now();
    for (const [key, cached] of this.latest) {
      if (cached.observedAt + cached.validForMs <= now) {
        this.latest.delete(key);
      }
    }
    const key = this.key(item);
    this.latest.delete(key);
    this.latest.set(key, value);
    while (this.latest.size > MAX_CACHED_RESULTS) {
      const oldest = this.latest.keys().next().value;
      if (oldest === undefined) break;
      this.latest.delete(oldest);
    }
    return value;
  }

  private key(item: InboxItem): string {
    return `${item.itemId}:${item.contentVersion}`;
  }
}

function result(
  state: InboxLiveCheckResult["state"],
  summary: string,
  validForMs: number,
): InboxLiveCheckResult {
  return {
    runId: randomUUID(),
    state,
    observedAt: Date.now(),
    summary,
    facts: [],
    validForMs,
  };
}
