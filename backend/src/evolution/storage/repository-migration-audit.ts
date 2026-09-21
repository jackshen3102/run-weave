import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateAsset,
  ContextPackManifest,
  EvolutionRepository,
  EvolutionRepositoryAttribution,
  InsightRevision,
} from "@runweave/shared/evolution";
import { resolveRepositoryIdentity } from "../../repository/identity";
import { queryActivityEvolutionEvidenceAvailability } from "../../activity/database/evolution-query";
import type { ActivityRepositoryBinding } from "../../activity/database/repository-index";

export interface MigrationManifest {
  version: 1;
  migrationId: string;
  createdAt: string;
  source: { activity: string; evolution: string };
  fingerprints: { activity: string; evolution: string };
  counts: {
    activity: Record<string, number>;
    evolution: Record<string, number>;
  };
  repositories: EvolutionRepository[];
  activityBindings: ActivityRepositoryBinding[];
  attributions: Array<{
    kind: string;
    id: string;
    value: EvolutionRepositoryAttribution;
  }>;
  insightMoves: Array<{
    id: string;
    repositoryId: string;
    canonicalId: string;
    conflict: boolean;
  }>;
  candidateMoves: Array<{
    revisionId: string;
    repositoryId: string;
    conflict: boolean;
  }>;
  schedules: Array<{
    id: string;
    repositoryId: string | null;
    cwd: string | null;
    wasEnabled: boolean;
  }>;
  immutable: Record<string, string>;
  activityDigests: Record<string, string>;
  digest: string;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function manifestDigest(manifest: MigrationManifest): string {
  const content = { ...manifest, digest: undefined };
  return hash(JSON.stringify(content));
}
export function openReadOnly(file: string): Database.Database {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  return database;
}
export function tables(database: Database.Database): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}
export function tableDigest(
  database: Database.Database,
  table: string,
): string {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("invalid_table");
  const digest = createHash("sha256");
  // Row order is kept by this additive migration; every original byte remains comparable.
  for (const row of database
    .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
    .iterate())
    digest.update(JSON.stringify(row) + "\n");
  return digest.digest("hex");
}
export function fingerprint(database: Database.Database): string {
  return hash(
    JSON.stringify(
      tables(database).map((table) => [table, tableDigest(database, table)]),
    ),
  );
}
function counts(database: Database.Database): Record<string, number> {
  return Object.fromEntries(
    tables(database).map((table) => [
      table,
      (
        database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}
export const IMMUTABLE_TABLES = [
  "context_packs",
  "context_pack_sources",
  "trace_segments",
  "episodes",
  "analysis_reports",
  "claims",
  "claim_novelty",
  "insight_revisions",
  "contribution_edges",
  "runtime_traces",
  "runtime_trace_events",
];

export async function auditRepositoryMigration(
  dataDir: string,
): Promise<MigrationManifest> {
  const source = {
    activity: path.join(dataDir, "activity/activity.sqlite"),
    evolution: path.join(dataDir, "evolution/learning.sqlite"),
  };
  const activity = openReadOnly(source.activity),
    evolution = openReadOnly(source.evolution);
  activity.exec("BEGIN");
  evolution.exec("BEGIN");
  try {
    const version = evolution
      .prepare("SELECT value FROM evolution_metadata WHERE key='schemaVersion'")
      .get() as { value: string } | undefined;
    if (Number(version?.value) >= 6)
      throw new Error("migration_source_already_repository_scoped");
    const repositories = new Map<string, EvolutionRepository>();
    const paths = new Map<string, string | null>();
    const roots = new Map<string, string>();
    const scopeCheckouts = new Map<string, Set<string>>();
    const repositoryBirth = new Map<string, number>();
    async function identify(raw: string | null): Promise<string | null> {
      if (!raw || !path.isAbsolute(raw)) return null;
      if (paths.has(raw)) return paths.get(raw)!;
      let cwd = raw;
      try {
        if ((await stat(cwd)).isFile()) cwd = path.dirname(cwd);
      } catch {
        paths.set(raw, null);
        return null;
      }
      const identity = await resolveRepositoryIdentity(cwd).catch(() => null);
      paths.set(raw, identity?.repositoryId ?? null);
      if (!identity) return null;
      repositoryBirth.set(
        identity.repositoryId,
        (await stat(identity.commonDirectory)).birthtimeMs,
      );
      roots.set(raw, identity.worktreeRoot);
      const previous = repositories.get(identity.repositoryId);
      repositories.set(identity.repositoryId, {
        repositoryId: identity.repositoryId,
        commonDirectory: identity.commonDirectory,
        name: path.basename(
          identity.commonDirectory === identity.worktreeRoot
            ? identity.worktreeRoot
            : path.dirname(identity.commonDirectory),
        ),
        paths: [
          ...new Set([...(previous?.paths ?? []), identity.worktreeRoot]),
        ],
        projectIds: [],
      });
      return identity.repositoryId;
    }
    const directories = activity
      .prepare("SELECT DISTINCT cwd FROM behavior_facts WHERE cwd IS NOT NULL")
      .all() as Array<{ cwd: string }>;
    for (const row of directories) await identify(row.cwd);
    const activityBindings: ActivityRepositoryBinding[] = [];
    const evidence = new Map<string, Set<string>>();
    type Fact = {
      event_id: string;
      cwd: string | null;
      terminal_session_id: string | null;
      thread_id: string | null;
      run_id: string | null;
      occurred_at_ms: number;
      event_name: string;
    };
    const facts = activity
      .prepare(
        "SELECT event_id,cwd,terminal_session_id,thread_id,run_id,occurred_at_ms,event_name FROM behavior_facts ORDER BY activity_offset",
      )
      .all() as Fact[];
    // A current path is only a candidate. Corroborate it with the original session
    // registration and reject repositories created after the historical fact.
    const historicalSessions = new Map<string, Set<string>>();
    for (const fact of facts)
      if (
        fact.event_name === "terminal.session.created" &&
        fact.terminal_session_id &&
        fact.cwd
      ) {
        const id = paths.get(fact.cwd);
        if (
          id &&
          (repositoryBirth.get(id) ?? Infinity) <= fact.occurred_at_ms
        ) {
          const ids =
            historicalSessions.get(fact.terminal_session_id) ??
            new Set<string>();
          ids.add(id);
          historicalSessions.set(fact.terminal_session_id, ids);
        }
      }
    const existingBindings = tables(activity).includes(
      "activity_repository_bindings",
    )
      ? new Map(
          (
            activity
              .prepare(
                "SELECT event_id,repository_id,common_directory FROM activity_repository_bindings WHERE repository_id IS NOT NULL",
              )
              .all() as Array<{
              event_id: string;
              repository_id: string;
              common_directory: string;
            }>
          ).map((row) => [row.event_id, row]),
        )
      : new Map<string, { repository_id: string; common_directory: string }>();
    const relationships = new Map<string, Set<string>>();
    for (const row of facts) {
      const registered = row.terminal_session_id
        ? historicalSessions.get(row.terminal_session_id)
        : undefined;
      const direct = row.cwd ? paths.get(row.cwd) : null;
      const historical = existingBindings.get(row.event_id);
      const repositoryId =
        historical?.repository_id ??
        (direct
          ? registered?.has(direct) &&
            (repositoryBirth.get(direct) ?? Infinity) <= row.occurred_at_ms
            ? direct
            : null
          : !row.cwd && registered?.size === 1
            ? [...registered][0]!
            : null);
      if (historical && !repositories.has(historical.repository_id))
        repositories.set(historical.repository_id, {
          repositoryId: historical.repository_id,
          commonDirectory: historical.common_directory,
          name: path.basename(path.dirname(historical.common_directory)),
          paths: row.cwd ? [row.cwd] : [],
          projectIds: [],
        });
      activityBindings.push({
        eventId: row.event_id,
        repositoryId,
        commonDirectory:
          historical?.common_directory ??
          (repositoryId
            ? repositories.get(repositoryId)!.commonDirectory
            : null),
        reason: historical
          ? "existing_repository_binding"
          : repositoryId
            ? "audited_terminal_session_registration"
            : "legacy_attribution_unresolved",
      });
      if (repositoryId) {
        evidence.set(`activity:${row.event_id}`, new Set([repositoryId]));
        for (const key of [
          row.thread_id ? `thread:${row.thread_id}` : null,
          row.run_id ? `run:${row.run_id}` : null,
        ])
          if (key) {
            const ids = relationships.get(key) ?? new Set<string>();
            ids.add(repositoryId);
            relationships.set(key, ids);
          }
      }
    }
    const packs: ContextPackManifest[] = [];
    const scopeEvidence = new Map<string, Set<string>>();
    for (const row of evolution
      .prepare(
        "SELECT manifest_json FROM context_packs ORDER BY context_pack_id",
      )
      .iterate() as Iterable<{ manifest_json: string }>) {
      const pack = JSON.parse(row.manifest_json) as ContextPackManifest;
      packs.push(pack);
      const scope =
        scopeEvidence.get(pack.learningScope.learningScopeId) ??
        new Set<string>();
      for (const item of pack.evidence) {
        scope.add(item.evidenceId);
        const relationship = item.relationships.threadId
          ? relationships.get(`thread:${item.relationships.threadId}`)
          : item.relationships.runId
            ? relationships.get(`run:${item.relationships.runId}`)
            : undefined;
        if (
          item.source !== "activity" &&
          item.source !== "repository" &&
          relationship
        )
          evidence.set(item.evidenceId, relationship);
        const repositoryId =
          item.source === "repository"
            ? await identify(item.origin.path)
            : null;
        if (
          repositoryId &&
          (repositoryBirth.get(repositoryId) ?? Infinity) <=
            Date.parse(pack.createdAt)
        ) {
          const ids = evidence.get(item.evidenceId) ?? new Set<string>();
          ids.add(repositoryId);
          evidence.set(item.evidenceId, ids);
          const checkout = item.origin.path
            ? roots.get(item.origin.path)
            : undefined;
          if (checkout) {
            const entries =
              scopeCheckouts.get(pack.learningScope.learningScopeId) ??
              new Set<string>();
            entries.add(checkout);
            scopeCheckouts.set(pack.learningScope.learningScopeId, entries);
          }
        }
      }
      scopeEvidence.set(pack.learningScope.learningScopeId, scope);
    }
    // Never infer a missing event cwd from an entire Project: the production inventory
    // already contains one Project with events from two separate repositories.
    function attribution(
      refs: string[],
      legacy: string,
    ): EvolutionRepositoryAttribution {
      const ids = [
        ...new Set(refs.flatMap((ref) => [...(evidence.get(ref) ?? [])])),
      ].sort();
      const missing =
        !refs.length || refs.some((ref) => !evidence.get(ref)?.size);
      const resolution =
        legacy === "global:runweave"
          ? "unresolved"
          : ids.length > 1
            ? "mixed"
            : ids.length === 1 && !missing
              ? "resolved"
              : "unresolved";
      return {
        repositoryIds: ids,
        resolution,
        legacyLearningScopeId: legacy,
        ...(resolution !== "resolved"
          ? {
              reason:
                legacy === "global:runweave"
                  ? "legacy_global_archive"
                  : missing
                    ? "evidence_repository_unresolved"
                    : "cross_repository_evidence",
            }
          : {}),
      };
    }
    const attributions: MigrationManifest["attributions"] = [];
    const byRun = new Map(packs.map((pack) => [pack.runId, pack]));
    const scopes = evolution
      .prepare("SELECT DISTINCT learning_scope_id FROM evolution_runs")
      .all() as Array<{ learning_scope_id: string }>;
    for (const row of scopes)
      attributions.push({
        kind: "scope",
        id: row.learning_scope_id,
        value: attribution(
          [...(scopeEvidence.get(row.learning_scope_id) ?? [])],
          row.learning_scope_id,
        ),
      });
    for (const row of evolution
      .prepare("SELECT run_id,learning_scope_id FROM evolution_runs")
      .iterate() as Iterable<{ run_id: string; learning_scope_id: string }>)
      attributions.push({
        kind: "run",
        id: row.run_id,
        value: attribution(
          byRun.get(row.run_id)?.evidence.map((item) => item.evidenceId) ?? [],
          row.learning_scope_id,
        ),
      });
    for (const row of evolution
      .prepare("SELECT trace_id,payload_json FROM runtime_traces")
      .iterate() as Iterable<{ trace_id: string; payload_json: string }>) {
      const trace = JSON.parse(row.payload_json) as {
        learningScopeId: string;
        runId: string;
      };
      const run = attributions.find(
        (item) => item.kind === "run" && item.id === trace.runId,
      );
      attributions.push({
        kind: "trace",
        id: row.trace_id,
        value: run?.value ?? attribution([], trace.learningScopeId),
      });
    }
    const insightMoves: MigrationManifest["insightMoves"] = [];
    const revisionRepository = new Map<
      string,
      EvolutionRepositoryAttribution
    >();
    const topics = new Map<string, Array<{ id: string; statement: string }>>();
    for (const row of evolution
      .prepare("SELECT * FROM insights ORDER BY created_at,insight_id")
      .iterate() as Iterable<{
      insight_id: string;
      learning_scope_id: string;
      topic_key: string;
      current_revision_id: string;
    }>) {
      const revisions = (
        evolution
          .prepare(
            "SELECT payload_json FROM insight_revisions WHERE insight_id = ?",
          )
          .all(row.insight_id) as Array<{ payload_json: string }>
      ).map((item) => JSON.parse(item.payload_json) as InsightRevision);
      for (const revision of revisions)
        revisionRepository.set(
          revision.revisionId,
          attribution(
            [...revision.evidenceIds, ...revision.counterEvidenceIds],
            row.learning_scope_id,
          ),
        );
      const value = attribution(
        revisions.flatMap((revision) => [
          ...revision.evidenceIds,
          ...revision.counterEvidenceIds,
        ]),
        row.learning_scope_id,
      );
      attributions.push({ kind: "insight", id: row.insight_id, value });
      if (value.resolution !== "resolved") continue;
      const repositoryId = value.repositoryIds[0]!;
      const key = `${repositoryId}:${row.topic_key}`;
      const group = topics.get(key) ?? [];
      group.push({
        id: row.insight_id,
        statement:
          revisions.find(
            (revision) => revision.revisionId === row.current_revision_id,
          )?.statement ?? "",
      });
      topics.set(key, group);
      insightMoves.push({
        id: row.insight_id,
        repositoryId,
        canonicalId: group[0]!.id,
        conflict: false,
      });
    }
    for (const group of topics.values())
      if (new Set(group.map((item) => item.statement)).size > 1)
        for (const move of insightMoves)
          if (move.canonicalId === group[0]!.id) move.conflict = true;
    const candidateMoves: MigrationManifest["candidateMoves"] = [];
    for (const row of evolution
      .prepare(
        `SELECT payload_json FROM (SELECT payload_json, ROW_NUMBER() OVER(PARTITION BY asset_id ORDER BY updated_at DESC,rowid DESC) AS n FROM candidate_asset_revisions) WHERE n=1`,
      )
      .iterate() as Iterable<{ payload_json: string }>) {
      const candidate = JSON.parse(row.payload_json) as CandidateAsset;
      const value = attribution(
        [...candidate.evidenceRefs, ...candidate.counterEvidenceRefs],
        candidate.learningScopeId,
      );
      attributions.push({ kind: "candidate", id: candidate.assetId, value });
      const revision = revisionRepository.get(candidate.insightRevisionId);
      if (
        value.resolution !== "resolved" ||
        revision?.resolution !== "resolved" ||
        revision.repositoryIds[0] !== value.repositoryIds[0]
      )
        continue;
      const owner = evolution
        .prepare("SELECT insight_id FROM insight_revisions WHERE revision_id=?")
        .get(candidate.insightRevisionId) as { insight_id: string } | undefined;
      const move = insightMoves.find((item) => item.id === owner?.insight_id);
      const refs = [...candidate.evidenceRefs, ...candidate.counterEvidenceRefs]
        .filter((ref) => ref.startsWith("activity:"))
        .map((ref) => ref.slice(9));
      const available =
        refs.length > 0 &&
        refs.every(
          (_, i) =>
            i % 1000 !== 0 ||
            queryActivityEvolutionEvidenceAvailability(
              activity,
              refs.slice(i, i + 1000),
            ).every((status) => status.availability === "available"),
        );
      if (move && available)
        candidateMoves.push({
          revisionId: candidate.revisionId,
          repositoryId: move.repositoryId,
          conflict: move.conflict,
        });
    }
    const schedules: MigrationManifest["schedules"] = [];
    for (const row of evolution
      .prepare(
        "SELECT schedule_id, learning_scope_id, enabled FROM evolution_schedules",
      )
      .iterate() as Iterable<{
      schedule_id: string;
      learning_scope_id: string;
      enabled: number;
    }>) {
      const value = attributions.find(
        (item) => item.kind === "scope" && item.id === row.learning_scope_id,
      )?.value;
      const repositoryId =
        value?.resolution === "resolved" ? value.repositoryIds[0]! : null;
      const checkouts = scopeCheckouts.get(row.learning_scope_id);
      schedules.push({
        id: row.schedule_id,
        repositoryId,
        cwd: repositoryId && checkouts?.size === 1 ? [...checkouts][0]! : null,
        wasEnabled: row.enabled === 1,
      });
    }
    const manifest: MigrationManifest = {
      version: 1,
      migrationId: randomUUID(),
      createdAt: new Date().toISOString(),
      source,
      fingerprints: {
        activity: fingerprint(activity),
        evolution: fingerprint(evolution),
      },
      counts: { activity: counts(activity), evolution: counts(evolution) },
      repositories: [...repositories.values()],
      activityBindings,
      attributions,
      insightMoves,
      candidateMoves,
      schedules,
      activityDigests: Object.fromEntries(
        tables(activity)
          .filter((table) => !table.startsWith("activity_repository_"))
          .map((table) => [table, tableDigest(activity, table)]),
      ),
      immutable: Object.fromEntries(
        IMMUTABLE_TABLES.map((table) => [table, tableDigest(evolution, table)]),
      ),
      digest: "",
    };
    manifest.digest = manifestDigest(manifest);
    return manifest;
  } finally {
    activity.close();
    evolution.close();
  }
}
