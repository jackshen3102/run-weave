import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
export function createBackup({
  config,
  env,
  getState,
  compose,
  sql,
  sum,
  run,
  remote,
}) {
  return async function snapshot(restart = true) {
    const state = getState();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
      directory = path.join(config.targetPath, "backups", stamp);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Infinite graceful stop waits for in-flight writes/uploads; no SIGKILL on a pause deadline.
    await compose(["stop", "--timeout", "-1", "api"]);
    const started = Date.now();
    let manifest;
    try {
      await compose(
        [
          "exec",
          "-T",
          "db",
          "pg_dump",
          "-U",
          "postgres",
          "-d",
          "suiji",
          "-Fc",
          "--no-owner",
          "--no-acl",
        ],
        { file: path.join(directory, "database.dump") },
      );
      await compose(
        [
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--entrypoint",
          "tar",
          "api",
          "-C",
          "/data/attachments",
          "-cf",
          "-",
          ".",
        ],
        { file: path.join(directory, "attachments.tar") },
      );
      const objects = JSON.parse(
        await sql(
          "SELECT coalesce(json_agg(json_build_object('key',object_key,'sha256',sha256,'bytes',byte_size)), '[]'::json) FROM attachments",
        ),
      );
      const counts = await sql(
        "SELECT json_build_object('records',(SELECT count(*) FROM records),'revisions',(SELECT count(*) FROM record_revisions),'mutations',(SELECT count(*) FROM mutation_requests),'attachments',(SELECT count(*) FROM attachments))",
      );
      manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        image: state?.image ?? env.SUIJI_IMAGE,
        appVersion: state?.revision ?? env.SUIJI_REVISION,
        schemaVersion: Number(
          await sql("SELECT count(*) FROM suiji_migrations"),
        ),
        identity: JSON.parse(
          await sql(
            "SELECT json_build_object('serverId',server_id,'ownerId',id) FROM server_identity CROSS JOIN owners",
          ),
        ),
        objects,
        counts: JSON.parse(counts),
        checksums: {
          "database.dump": await sum(path.join(directory, "database.dump")),
          "attachments.tar": await sum(path.join(directory, "attachments.tar")),
        },
      };
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        { mode: 0o600 },
      );
    } finally {
      if (restart) await compose(["start", "api"]);
    }
    if (Date.now() - started > config.pauseSeconds * 1000)
      throw new Error(
        "Backup exceeded declared pause window; local files retained, backup not complete",
      );
    await run("rsync", [
      "-a",
      "--checksum",
      "--",
      directory + "/",
      config.backupLocation + "/" + stamp + "/",
    ]);
    const check = ["manifest.json", "database.dump", "attachments.tar"];
    for (const file of check) {
      const remoteHash = await run("ssh", [
        remote[1] + "@" + remote[2],
        "sha256sum",
        remote[3] + "/" + stamp + "/" + file,
      ]);
      if (
        remoteHash.split(/\s+/)[0] !== (await sum(path.join(directory, file)))
      )
        throw new Error("Off-host backup checksum mismatch");
    }
    const pending = path.join(directory, "complete.pending.json");
    await writeFile(
      pending,
      JSON.stringify({
        copiedTo: config.backupLocation,
        completedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await run("rsync", [
      "-a",
      "--checksum",
      "--",
      pending,
      config.backupLocation + "/" + stamp + "/complete.json",
    ]);
    const marker = await run("ssh", [
      remote[1] + "@" + remote[2],
      "sha256sum",
      remote[3] + "/" + stamp + "/complete.json",
    ]);
    if (marker.split(/\s+/)[0] !== (await sum(pending)))
      throw new Error("Off-host completion marker mismatch");
    await rename(pending, path.join(directory, "complete.json"));
    return directory;
  };
}
