import Database from "better-sqlite3";
import path from "node:path";
import type { EvolutionSchedule } from "@runweave/shared/evolution";
import { resolveRepositoryIdentity } from "../../repository/identity";
import { nextCronOccurrence } from "../cron";
import type { MigrationManifest } from "./repository-migration-audit";
import { openReadOnly } from "./repository-migration-audit";
import { assertOffline } from "./repository-migration-files";
import { verifyRepositoryMigration } from "./repository-migration-apply";

/** Explicit post-verification operation; enabling schedules closes the automatic rollback window. */
export async function resumeMigratedSchedules(
  manifest: MigrationManifest,
  dataDir: string,
) {
  const file = path.join(dataDir, "evolution/learning.sqlite");
  assertOffline([file, path.join(dataDir, "activity/activity.sqlite")]);
  const state = openReadOnly(file);
  try {
    const completed = state
      .prepare(
        "SELECT value FROM evolution_metadata WHERE key='repositorySchedulesResumed'",
      )
      .get() as { value: string } | undefined;
    if (completed?.value === manifest.migrationId)
      return { resumed: [], paused: [], alreadyResumed: true };
  } finally {
    state.close();
  }
  verifyRepositoryMigration(manifest, dataDir);
  const resumable: string[] = [];
  for (const item of manifest.schedules) {
    if (!item.wasEnabled || !item.repositoryId || !item.cwd) continue;
    const identity = await resolveRepositoryIdentity(item.cwd).catch(
      () => null,
    );
    if (identity?.repositoryId === item.repositoryId) resumable.push(item.id);
  }
  const original = openReadOnly(
    path.join(
      dataDir,
      "evolution/repository-migrations",
      manifest.migrationId,
      "evolution.sqlite",
    ),
  );
  const database = new Database(file);
  try {
    database
      .transaction(() => {
        for (const id of resumable) {
          const row = database
            .prepare(
              "SELECT payload_json FROM evolution_schedules WHERE schedule_id=?",
            )
            .get(id) as { payload_json: string };
          const old = original
            .prepare(
              "SELECT payload_json FROM evolution_schedules WHERE schedule_id=?",
            )
            .get(id) as { payload_json: string };
          const previous = JSON.parse(old.payload_json) as EvolutionSchedule;
          const schedule = JSON.parse(row.payload_json) as EvolutionSchedule;
          schedule.enabled = true;
          schedule.updatedAt = new Date().toISOString();
          delete schedule.pausedReason;
          schedule.nextDueAt =
            previous.nextDueAt ??
            nextCronOccurrence(
              schedule.cronExpression,
              schedule.timezone,
              new Date(),
            ).toISOString();
          database
            .prepare(
              "UPDATE evolution_schedules SET enabled=1,updated_at_ms=?,payload_json=? WHERE schedule_id=?",
            )
            .run(Date.parse(schedule.updatedAt), JSON.stringify(schedule), id);
        }
        // Commit the receipt with the schedules: a crash before returning must
        // never re-enable a schedule that the user subsequently paused.
        database
          .prepare(
            "INSERT INTO evolution_metadata(key,value) VALUES ('repositorySchedulesResumed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(manifest.migrationId);
      })
      .immediate();
    return {
      resumed: resumable,
      paused: manifest.schedules
        .filter((item) => item.wasEnabled && !resumable.includes(item.id))
        .map((item) => item.id),
    };
  } finally {
    original.close();
    database.close();
  }
}
