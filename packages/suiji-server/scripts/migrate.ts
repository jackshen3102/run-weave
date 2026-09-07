import { createHash } from "node:crypto";
import { readdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(
  here,
  here.endsWith("/scripts") ? "../migrations" : "migrations",
);
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL required");
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const staging = await mkdtemp(path.join(os.tmpdir(), "suiji-migrations-"));
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(78347832)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS suiji_migration_checksums(name text PRIMARY KEY,sha256 text NOT NULL)",
  );
  const files = (await readdir(directory))
    .filter((f) => /^\d+-[a-z0-9-]+\.cjs$/.test(f))
    .sort();
  const hashes = new Map<string, string>();
  for (const file of files)
    hashes.set(
      file.replace(/\.cjs$/, ""),
      createHash("sha256")
        .update(await readFile(path.join(directory, file)))
        .digest("hex"),
    );
  const old = await client.query(
    "SELECT name,sha256 FROM suiji_migration_checksums",
  );
  for (const row of old.rows)
    if (hashes.get(row.name) !== row.sha256)
      throw new Error(`Migration checksum drift: ${row.name}`);
  const historyExists = (
    await client.query("SELECT to_regclass('public.suiji_migrations') AS name")
  ).rows[0].name;
  if (historyExists) {
    const history = (
      await client.query("SELECT name FROM suiji_migrations")
    ).rows.map((r) => r.name);
    if (
      history.length !== old.rows.length ||
      history.some((name) => !old.rows.some((r) => r.name === name))
    )
      throw new Error("Migration history/checksum mismatch");
  }
  for (const file of files) {
    const name = file.replace(/\.cjs$/, "");
    // The checksum statement joins the migration and tool history in the SAME transaction.
    const source = `const migration=require(${JSON.stringify(path.join(directory, file))});\nexports.up=async pgm=>{pgm.noTransaction=()=>{throw new Error('Nontransactional migration forbidden')};await migration.up(pgm);pgm.sql(${JSON.stringify(`INSERT INTO suiji_migration_checksums(name,sha256) VALUES('${name}','${hashes.get(name)}')`)});};\nexports.down=false;\n`;
    await writeFile(path.join(staging, file), source, { mode: 0o600 });
  }
  await runner({
    dbClient: client,
    dir: staging,
    direction: "up",
    migrationsTable: "suiji_migrations",
    singleTransaction: true,
    noLock: true,
    log: () => {},
  });
  console.log(
    JSON.stringify({ event: "migrated", schemaVersion: hashes.size }),
  );
} catch (error) {
  // Never log driver errors containing SQL or connection strings.
  console.error(
    error instanceof Error &&
      /^(Migration |Nontransactional)/.test(error.message)
      ? error.message
      : "Migration failed; no API replacement permitted",
  );
  process.exitCode = 1;
} finally {
  await client.end();
  await rm(staging, { recursive: true, force: true });
}
