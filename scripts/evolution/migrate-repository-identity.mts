import { resumeMigratedSchedules } from "../../backend/src/evolution/storage/repository-migration-schedules.ts";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditRepositoryMigration,
  type MigrationManifest,
} from "../../backend/src/evolution/storage/repository-migration-audit.ts";
import {
  applyRepositoryMigration,
  privateJson,
  rollbackRepositoryMigration,
  verifyRepositoryMigration,
} from "../../backend/src/evolution/storage/repository-migration-apply.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    output: { type: "string" },
    manifest: { type: "string" },
    "migration-id": { type: "string" },
    "resume-schedules": { type: "boolean" },
  },
});
try {
  const command = positionals[0];
  if (command !== "audit" && !values["data-dir"])
    throw new Error("explicit_data_dir_required_for_migration");
  const directory = path.resolve(
    values["data-dir"] ?? path.join(os.homedir(), ".runweave"),
  );
  if (command === "audit") {
    if (!values.output) throw new Error("audit_output_required");
    const manifest = await auditRepositoryMigration(directory);
    privateJson(path.resolve(values.output), manifest);
    console.log(
      JSON.stringify({
        ok: true,
        mode: "read_only",
        migrationId: manifest.migrationId,
        manifest: path.resolve(values.output),
        digest: manifest.digest,
        counts: manifest.counts,
        repositories: manifest.repositories.length,
        resolvedEvents: manifest.activityBindings.filter(
          (item) => item.repositoryId,
        ).length,
        unresolvedEvents: manifest.activityBindings.filter(
          (item) => !item.repositoryId,
        ).length,
        insightMoves: manifest.insightMoves.length,
        candidateMoves: manifest.candidateMoves.length,
        pausedSchedules: manifest.schedules.filter((item) => !item.repositoryId)
          .length,
      }),
    );
  } else if (command === "rollback") {
    if (!values["migration-id"]) throw new Error("migration_id_required");
    console.log(
      JSON.stringify(
        await rollbackRepositoryMigration(directory, values["migration-id"]),
      ),
    );
  } else if (command === "apply" || command === "verify") {
    if (!values.manifest) throw new Error("manifest_required");
    const manifest = JSON.parse(
      readFileSync(values.manifest, "utf8"),
    ) as MigrationManifest;
    console.log(
      JSON.stringify(
        command === "apply"
          ? await applyRepositoryMigration(manifest, directory)
          : values["resume-schedules"]
            ? await resumeMigratedSchedules(manifest, directory)
            : verifyRepositoryMigration(manifest, directory),
      ),
    );
  } else
    throw new Error(
      "usage: audit|apply|verify|rollback --data-dir DIR --output FILE|--manifest FILE|--migration-id ID",
    );
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
