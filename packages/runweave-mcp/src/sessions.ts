import type { SessionSearchContext, SessionSearchQuery, SessionSearchResponse, SessionSearchStatus } from "@runweave/shared/session-search";
import type { Backend } from "./backend.js";
import type { Evidence } from "./evidence.js";

/** The Backend owns native transcript indexing; this MCP never creates a second index. */
export class NativeSessions {
  private initialRefresh?: Promise<void>;
  constructor(private backend: Backend, private evidence: Evidence, private cwd: string) {}
  private initialize() {
    // ags 0.5.0 attempts one refresh per MCP process, including when that attempt fails.
    return this.initialRefresh ??= this.backend.post("/api/session-search/refresh", {}, 30 * 60_000).then(() => undefined, () => undefined);
  }
  async status() { await this.initialize(); return this.backend.get<SessionSearchStatus>("/api/session-search/status"); }
  async search(query: SessionSearchQuery) {
    await this.initialize();
    const scope = query.allProjects || query.projectId || query.cwd ? {} : { cwd: this.cwd };
    const page = await this.backend.get<SessionSearchResponse>("/api/session-search/search", { ...scope, ...query, noUpdate: true });
    const results = page.hits.map(hit => this.evidence.add(`${hit.provider} · ${hit.title}`, async () => {
      const context = await this.backend.get<SessionSearchContext>(`/api/session-search/records/${encodeURIComponent(hit.id)}`, { noUpdate: true });
      if (context.sourceState !== "verified" || context.hit.location.sha256 !== hit.location.sha256)
        throw new Error("native_source_changed_or_missing: search again");
      return { text: JSON.stringify(context), metadata: {
        kind: "native_session", provider: hit.provider, threadId: hit.threadId,
        location: hit.location, partial: context.partial, live: false,
        indexedAt: page.coverage.lastScanAt, sourceNode: page.coverage.node,
      } };
    }));
    results.push(this.evidence.note("Native session search coverage", { query: page.query, level: page.level,
      partial: page.partial, nextCursor: page.nextCursor, coverage: page.coverage }));
    return { results };
  }
}
