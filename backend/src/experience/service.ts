import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ExperienceDraft,
  ExperienceDiagnostics,
  ExperienceCandidate,
  ExperienceFeedback,
  ExperienceFeedbackInput,
  ExperienceRecord,
  ExperienceSearchResult,
  ExperienceView,
} from "@runweave/shared/experience";
import { withExperienceStore, type ExperienceStorage } from "./storage";
import { snapshotEvidence, inspectEvidence } from "./evidence";
import { draftSchema, experienceIdSchema, feedbackSchema } from "./schema";

import { resolveRepositoryIdentity } from "../repository/identity";
interface Scope {
  repositoryId: string;
  namespace: string;
  root: string;
  directory: string;
}
interface Lookup {
  repositoryId: string;
  namespace: string;
  matches: Array<{ id: string; revision: string }>;
  query: string;
  at: string;
  excluded: ExperienceSearchResult["excluded"];
}

export class ExperienceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Repository identity is independent of Backend registration, profile and port. */
export class ExperienceService {
  constructor(private readonly storage: ExperienceStorage) {}

  async scope(cwd: string): Promise<Scope> {
    if (!path.isAbsolute(cwd))
      throw new ExperienceError("experience_cwd_must_be_absolute");
    const identity = await resolveRepositoryIdentity(cwd).catch(() => {
      throw new ExperienceError("experience_git_repository_required");
    });
    const repositoryId = identity.repositoryId;
    return {
      repositoryId,
      namespace: this.storage.namespace,
      root: identity.worktreeRoot,
      directory: path.join(
        this.storage.home,
        this.storage.namespace,
        repositoryId,
      ),
    };
  }

  async search(cwd: string, query: string): Promise<ExperienceSearchResult> {
    const scope = await this.scope(cwd);
    const records = await this.records(scope);
    const matches: ExperienceSearchResult["matches"] = [];
    const excluded: ExperienceSearchResult["excluded"] = [];
    for (const record of records) {
      const groups = record.triggers.map((group) =>
        group.filter((term) => matchesTerm(query, term)),
      );
      if (groups.some((group) => !group.length)) continue;
      const view = await this.inspect(record);
      if (!view.available)
        excluded.push({ id: record.id, reasons: view.invalidReasons });
      else matches.push({ ...view, matchedTerms: groups.flat() });
    }
    matches.sort(
      (a, b) =>
        b.matchedTerms.length - a.matchedTerms.length ||
        a.record.id.localeCompare(b.record.id),
    );
    const result: ExperienceSearchResult = {
      lookupId: randomUUID(),
      repositoryId: scope.repositoryId,
      namespace: scope.namespace,
      matches: matches.slice(0, 3),
      excluded,
    };
    withExperienceStore(scope.directory, (store) =>
      store.put("lookups", result.lookupId, {
        repositoryId: scope.repositoryId,
        namespace: scope.namespace,
        query,
        at: new Date().toISOString(),
        matches: result.matches.map(({ record }) => ({
          id: record.id,
          revision: record.revision,
        })),
        excluded,
      }),
    );
    return result;
  }

  /** Read existing observations and preview retrieval without polluting usage history. */
  async diagnose(cwd: string, query?: string): Promise<ExperienceDiagnostics> {
    const scope = await this.scope(cwd);
    const records = await this.records(scope);
    const { lookups, feedback } = withExperienceStore(
      scope.directory,
      (store) => ({
        lookups: store.list<Lookup>("lookups"),
        feedback: store.list<ExperienceFeedback>("feedback"),
      }),
    );
    const result: ExperienceDiagnostics = {
      repositoryId: scope.repositoryId,
      namespace: scope.namespace,
      lookups: {
        total: lookups.length,
        withMatches: lookups.filter((lookup) => lookup.matches.length > 0)
          .length,
        withFeedback: new Set(feedback.map((receipt) => receipt.lookupId)).size,
        recent: lookups
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 20)
          .map(({ query, at, matches, excluded }) => ({
            query,
            at,
            matches,
            excluded,
          })),
      },
      feedback: {
        used: feedback.filter((receipt) => receipt.decision === "used").length,
        dismissed: feedback.filter(
          (receipt) => receipt.decision === "dismissed",
        ).length,
        attribution: "agent_report",
      },
      records: [],
    };
    for (const record of records) {
      const view = await this.inspect(record);
      const receipts = feedback.filter((receipt) => receipt.id === record.id);
      const groups =
        query === undefined
          ? undefined
          : record.triggers.map((group) =>
              group.filter((term) => matchesTerm(query, term)),
            );
      const missingGroups = groups
        ? record.triggers.filter((_, index) => !groups[index]?.length)
        : [];
      result.records.push({
        id: record.id,
        revision: record.revision,
        title: record.title,
        available: view.available,
        invalidReasons: view.invalidReasons,
        returned: lookups.filter((lookup) =>
          lookup.matches.some((match) => match.id === record.id),
        ).length,
        used: receipts.filter((receipt) => receipt.decision === "used").length,
        dismissed: receipts.filter(
          (receipt) => receipt.decision === "dismissed",
        ).length,
        ...(groups
          ? {
              queryMatch: {
                matchedTerms: groups.flat(),
                missingGroups,
                outcome: missingGroups.length
                  ? ("trigger_mismatch" as const)
                  : !view.available
                    ? ("excluded" as const)
                    : ("ranked_out" as const),
              },
            }
          : {}),
      });
    }
    result.records
      .filter((record) => record.queryMatch?.outcome === "ranked_out")
      .sort(
        (a, b) =>
          b.queryMatch!.matchedTerms.length -
            a.queryMatch!.matchedTerms.length || a.id.localeCompare(b.id),
      )
      .slice(0, 3)
      .forEach((record) => {
        record.queryMatch!.outcome = "returned";
      });
    return result;
  }

  async show(cwd: string, id: string): Promise<ExperienceView> {
    const scope = await this.scope(cwd);
    return this.inspect(await this.load(scope, id));
  }

  async save(
    cwd: string,
    draft: ExperienceDraft,
    expectedRevision?: string,
  ): Promise<ExperienceView> {
    const scope = await this.scope(cwd);
    const record = await this.prepare(cwd, draft);
    withExperienceStore(scope.directory, (store) =>
      store.transaction(() => {
        const previous = store.get<ExperienceRecord>("records", draft.id);
        if ((previous?.revision ?? undefined) !== expectedRevision)
          throw new ExperienceError("experience_revision_conflict", 409);
        store.put("revisions", record.revision, record);
        store.put("records", record.id, record);
      }),
    );
    return this.inspect(record);
  }

  async prepare(
    cwd: string,
    draft: ExperienceDraft,
  ): Promise<ExperienceRecord> {
    const parsed = draftSchema.parse(draft);
    const scope = await this.scope(cwd);
    const record: ExperienceRecord = {
      ...parsed,
      repositoryId: scope.repositoryId,
      namespace: scope.namespace,
      revision: randomUUID(),
      updatedAt: new Date().toISOString(),
      evidence: await Promise.all(parsed.evidence.map(snapshotEvidence)),
    };
    return record;
  }

  async listRecords(cwd: string): Promise<ExperienceRecord[]> {
    return this.records(await this.scope(cwd));
  }

  /** Read-only publication boundary; does not create lookups or feedback. */
  async publicationRecords(cwd: string): Promise<Array<{
    view: ExperienceView; revisions: ExperienceRecord[];
  }>> {
    const scope = await this.scope(cwd);
    const records = await this.records(scope);
    const revisions = withExperienceStore(scope.directory, (store) =>
      store.list<ExperienceRecord>("revisions"),
    );
    return Promise.all(records.map(async (record) => ({
      view: await this.inspect(record),
      revisions: revisions.filter((revision) => revision.id === record.id),
    })));
  }

  async candidates(cwd: string): Promise<ExperienceCandidate[]> {
    const scope = await this.scope(cwd);
    const candidates = withExperienceStore(scope.directory, (store) =>
      store.list<ExperienceCandidate>("candidates"),
    );
    return candidates.map((candidate) => ({
      ...candidate,
      record: withoutLegacyCodeHashes(candidate.record),
    }));
  }

  async stage(
    cwd: string,
    candidate: ExperienceCandidate,
  ): Promise<ExperienceCandidate> {
    const scope = await this.scope(cwd);
    this.checkScope(scope, candidate.record);
    return withExperienceStore(scope.directory, (store) =>
      store.transaction(() => {
        const existing = store.get<ExperienceCandidate>(
          "candidates",
          candidate.candidateId,
        );
        if (existing) return existing;
        store.put("candidates", candidate.candidateId, candidate);
        return candidate;
      }),
    );
  }

  async reviewCandidate(
    cwd: string,
    candidateId: string,
    review: NonNullable<ExperienceCandidate["review"]>,
  ): Promise<ExperienceCandidate> {
    const scope = await this.scope(cwd);
    const candidate = (await this.candidates(cwd)).find(
      (c) => c.candidateId === candidateId,
    );
    if (!candidate)
      throw new ExperienceError("experience_candidate_not_found", 404);
    if (candidate.status !== "pending") return candidate;
    const view = await this.inspect(candidate.record);
    return withExperienceStore(scope.directory, (store) =>
      store.transaction(() => {
        const latest = store.get<ExperienceCandidate>(
          "candidates",
          candidateId,
        )!;
        if (latest.status !== "pending") return latest;
        const current = store.get<ExperienceRecord>(
          "records",
          candidate.record.id,
        );
        const next: ExperienceCandidate = {
          ...latest,
          record: withoutLegacyCodeHashes(latest.record),
          review,
        };
        if (review.verdict === "contradicted") next.status = "rejected";
        if (review.verdict === "supported") {
          if (!view.available)
            next.review = {
              verdict: "insufficient",
              reason: view.invalidReasons.join(","),
            };
          else if ((current?.revision ?? null) !== candidate.expectedRevision)
            next.review = {
              verdict: "insufficient",
              reason: "experience_revision_conflict",
            };
          else {
            store.put("revisions", candidate.record.revision, candidate.record);
            store.put("records", candidate.record.id, candidate.record);
            next.status = "promoted";
          }
        }
        store.put("candidates", candidateId, next);
        return next;
      }),
    );
  }

  async feedback(
    cwd: string,
    input: ExperienceFeedbackInput,
  ): Promise<ExperienceFeedback> {
    feedbackSchema.parse(input);
    const scope = await this.scope(cwd);
    const lookup = withExperienceStore(scope.directory, (store) =>
      store.get<Lookup>("lookups", input.lookupId),
    );
    if (!lookup) throw new ExperienceError("experience_lookup_not_found", 404);
    if (
      lookup.repositoryId !== scope.repositoryId ||
      lookup.namespace !== scope.namespace ||
      !lookup.matches.some(
        (item) => item.id === input.id && item.revision === input.revision,
      )
    )
      throw new ExperienceError("experience_not_in_lookup", 409);
    const result: ExperienceFeedback = {
      ...input,
      feedbackId: randomUUID(),
      repositoryId: scope.repositoryId,
      namespace: scope.namespace,
      recordedAt: new Date().toISOString(),
      attribution: "agent_report",
      evidence: await Promise.all(input.evidence.map(snapshotEvidence)),
    };
    withExperienceStore(scope.directory, (store) =>
      store.transaction(() => {
        // Record the version actually retrieved, even if the task or record has since changed.
        store.put("feedback", result.feedbackId, result);
        const record = store.get<ExperienceRecord>("records", input.id);
        // A late failure of an older version must not retire a newer recommendation.
        if (
          input.decision === "used" &&
          input.result === "failed" &&
          record?.revision === input.revision &&
          record.state === "active"
        ) {
          const invalidated: ExperienceRecord = {
            ...withoutLegacyCodeHashes(record),
            state: "needs_revalidation",
            revision: randomUUID(),
            updatedAt: new Date().toISOString(),
          };
          store.put("revisions", invalidated.revision, invalidated);
          store.put("records", invalidated.id, invalidated);
        }
      }),
    );
    return result;
  }

  async history(cwd: string): Promise<ExperienceFeedback[]> {
    const scope = await this.scope(cwd);
    return withExperienceStore(scope.directory, (store) =>
      store.list<ExperienceFeedback>("feedback"),
    );
  }

  private async records(scope: Scope): Promise<ExperienceRecord[]> {
    const stored = withExperienceStore(scope.directory, (store) =>
      store.list<ExperienceRecord>("records"),
    );
    const records = stored.map(withoutLegacyCodeHashes);
    for (const record of records) this.checkScope(scope, record);
    return records;
  }

  private checkScope(scope: Scope, record: ExperienceRecord): void {
    if (
      record.repositoryId !== scope.repositoryId ||
      record.namespace !== scope.namespace
    )
      throw new ExperienceError("experience_scope_mismatch", 409);
  }

  private async load(scope: Scope, id: string): Promise<ExperienceRecord> {
    experienceIdSchema.parse(id);
    const record = withExperienceStore(scope.directory, (store) =>
      store.get<ExperienceRecord>("records", id),
    );
    if (!record) throw new ExperienceError("experience_not_found", 404);
    this.checkScope(scope, record);
    if (record.id !== id)
      throw new ExperienceError("experience_scope_mismatch", 409);
    return withoutLegacyCodeHashes(record);
  }

  private async inspect(record: ExperienceRecord): Promise<ExperienceView> {
    const reasons: string[] = [];
    if (record.state !== "active") reasons.push(record.state);
    if (Date.parse(record.expiresAt) <= Date.now()) reasons.push("expired");
    for (const evidence of record.evidence) {
      const reason = await inspectEvidence(evidence);
      if (reason) reasons.push(reason);
    }
    return { record, available: !reasons.length, invalidReasons: reasons };
  }
}

/** Keep old SQLite records readable without propagating obsolete source fingerprints. */
function withoutLegacyCodeHashes(record: ExperienceRecord): ExperienceRecord {
  const { codeHashes, ...current } = record as ExperienceRecord & {
    codeHashes?: unknown;
  };
  void codeHashes;
  return current;
}

function matchesTerm(query: string, term: string): boolean {
  const haystack = query.normalize("NFKC").toLowerCase();
  const needle = term.normalize("NFKC").toLowerCase();
  if (/^[a-z0-9 _-]+$/u.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(
      haystack,
    );
  }
  return haystack.includes(needle);
}
