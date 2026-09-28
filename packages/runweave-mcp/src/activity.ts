import { createHash } from "node:crypto";
import type {
  ActivityContentValueDto,
  ActivityFactDto,
  ActivityFactsPage,
} from "@runweave/shared/activity";
import { Backend } from "./backend.js";
import { Evidence } from "./evidence.js";

export interface ActivityFilters {
  from?: string;
  to?: string;
  projectId?: string;
  threadId?: string;
  runtimeChannel?: string;
  eventName?: string;
  eventId?: string;
  operationId?: string;
  correlationId?: string;
  resultStatus?: string;
}

export class Activity {
  constructor(
    private backend: Backend,
    private evidence: Evidence,
  ) {}

  async page(
    filters: ActivityFilters,
    cursor?: string,
    limit = 50,
    maxScan = 2000,
  ) {
    const state = cursor
      ? (JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
          key: string;
          cursor: string;
          asOf: number;
          from: string;
          to: string;
        })
      : undefined;
    if (
      state &&
      (!Number.isSafeInteger(state.asOf) || typeof state.cursor !== "string")
    )
      throw new Error("cursor_query_mismatch");
    const from =
      filters.from ??
      state?.from ??
      new Date(Date.now() - 86400_000).toISOString();
    const to = filters.to ?? state?.to ?? new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(from) >= Date.parse(to)
    )
      throw new Error("invalid_time_range");
    const effectiveFilters = { ...filters, from, to };
    const key = createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(effectiveFilters)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex");
    if (state && state.key !== key) throw new Error("cursor_query_mismatch");
    let next = state?.cursor;
    let asOf = state?.asOf;
    let scanned = 0;
    let exhausted = false;
    const rows: ActivityFactDto[] = [];
    const deadline = Date.now() + 20_000;
    do {
      // Keep source-page size <= remaining output capacity, so no match is lost.
      const page = await this.backend.get<ActivityFactsPage>(
        "/api/activity/facts",
        {
          ...effectiveFilters,
          cursor: next,
          asOfActivityOffset: asOf,
          limit: Math.min(200, limit - rows.length, maxScan - scanned),
        },
      );
      asOf ??= page.asOfActivityOffset;
      scanned += page.facts.length;
      for (const fact of page.facts) {
        // Older installed Backends ignore the new fields. Recheck them locally.
        const occurred = Date.parse(fact.occurredAt);
        if (occurred < Date.parse(from) || occurred >= Date.parse(to)) continue;
        if (filters.eventId && fact.eventId !== filters.eventId) continue;
        if (
          filters.operationId &&
          fact.scope.operationId !== filters.operationId
        )
          continue;
        if (
          filters.correlationId &&
          fact.correlationId !== filters.correlationId
        )
          continue;
        rows.push(fact);
      }
      if (
        !page.nextCursor ||
        (page.facts.length > 0 &&
          Date.parse(page.facts.at(-1)!.occurredAt) < Date.parse(from))
      )
        exhausted = true;
      if (page.nextCursor === next && page.nextCursor)
        throw new Error("backend_cursor_did_not_advance");
      next = page.nextCursor;
    } while (
      !exhausted &&
      rows.length < limit &&
      scanned < maxScan &&
      Date.now() < deadline
    );
    const counts: Record<string, number> = {};
    for (const row of rows)
      counts[row.result?.status ?? "unknown"] =
        (counts[row.result?.status ?? "unknown"] ?? 0) + 1;
    return {
      rows,
      effectiveFilters,
      asOfActivityOffset: asOf,
      scannedRecords: scanned,
      matchedRecords: rows.length,
      counts,
      metricDefinition:
        "counts describe only rows in this response, grouped by result.status; event counts are not request counts",
      coverage: exhausted ? "completeForRemainingScope" : "partial",
      nextCursor:
        !exhausted && next
          ? Buffer.from(
              JSON.stringify({ key, cursor: next, asOf, from, to }),
            ).toString("base64url")
          : undefined,
    };
  }

  content(
    contentId: string,
    offset = 0,
    expectedHash?: string,
  ): { id: string; title: string; url: string } {
    return this.evidence.add(
      `Activity content ${contentId} @ character ${offset}`,
      async () => {
        const value = await this.backend.get<ActivityContentValueDto>(
          `/api/activity/contents/${encodeURIComponent(contentId)}`,
        );
        if (
          value.availability !== "available" ||
          !value.bytesBase64 ||
          Date.parse(value.expectedExpiresAt) <= Date.now()
        ) {
          throw new Error(
            `activity_content_unavailable: ${value.availability}`,
          );
        }
        if (expectedHash && expectedHash !== value.sha256)
          throw new Error("source_changed");
        const all = Buffer.from(value.bytesBase64, "base64").toString("utf8");
        let end = Math.min(offset + 16_384, all.length);
        if (
          end < all.length &&
          all.charCodeAt(end - 1) >= 0xd800 &&
          all.charCodeAt(end - 1) <= 0xdbff
        )
          end--;
        const next =
          end < all.length
            ? this.content(contentId, end, value.sha256)
            : undefined;
        return {
          text: all.slice(offset, end),
          metadata: {
            kind: "activity_content",
            contentId,
            eventId: value.eventId,
            role: value.role,
            sourceSha256: value.sha256,
            expectedExpiresAt: value.expectedExpiresAt,
            offset,
            next,
            sourceHasMore: Boolean(next),
          },
        };
      },
    );
  }

  fact(fact: ActivityFactDto) {
    const contentRefs = fact.contentDescriptors.map((d) =>
      this.content(d.contentId),
    );
    return this.evidence.add(
      `${fact.occurredAt} ${fact.eventName}`,
      async () => {
        const page = await this.backend.get<ActivityFactsPage>(
          "/api/activity/facts",
          {
            eventId: fact.eventId,
            search: fact.eventId,
            limit: 1,
          },
        );
        if (
          !page.facts.some((f) => f.eventId === fact.eventId) ||
          Date.parse(fact.expiresAt) <= Date.now()
        )
          throw new Error("activity_fact_expired_or_deleted");
        return {
          text: JSON.stringify({ fact, contentRefs }, null, 2),
          metadata: {
            kind: "activity_fact",
            eventId: fact.eventId,
            observedAt: new Date().toISOString(),
            revisionStatus:
              fact.runtime.sourceRevision &&
              fact.runtime.sourceRevision !== "bundled"
                ? "reported"
                : "unknown",
            relationships:
              "Only exact IDs establish links; temporal proximity is a candidate, not causation",
          },
        };
      },
    );
  }
}
