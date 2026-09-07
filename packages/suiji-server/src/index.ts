import { readConfig } from "./config";
import { createPool } from "./db/pool";
import { LocalFileStore } from "./storage/local-files";
import { createApp } from "./http/app";
const config = readConfig(),
  pool = createPool(config.DATABASE_URL),
  store = new LocalFileStore(config.SUIJI_STORAGE_DIR);
await store.initialize();
const dbVersion = (await pool.query("SHOW server_version_num")).rows[0]
  .server_version_num;
if (Math.floor(Number(dbVersion) / 10000) !== 18)
  throw new Error("PostgreSQL 18 required");
const schema = await pool.query(
  "SELECT count(*)::int AS version FROM suiji_migrations",
);
if (schema.rows[0].version !== 2)
  throw new Error(
    "Unsupported schema version; migrate with a compatible artifact",
  );
const app = createApp(pool, store, config);
const server = app.listen(
  config.SUIJI_PORT,
  config.SUIJI_HOST,
  () =>
    console.log(
      JSON.stringify({
        event: "ready",
        port: config.SUIJI_PORT,
        version: config.SUIJI_APP_VERSION,
      }),
    ),
);
server.requestTimeout = 60000;
pool.on("error", () =>
  console.error(JSON.stringify({ event: "database_connection_error" })),
);
const metrics = setInterval(() => {
  void Promise.all([
    store.statistics(),
    pool.query("SELECT count(*)::int AS count FROM attachments"),
  ])
    .then(([disk, rows]) =>
      console.log(
        JSON.stringify({
          event: "storage",
          ...disk,
          orphanObjects: Math.max(0, disk.objects - rows.rows[0].count),
        }),
      ),
    )
    .catch(() =>
      console.error(JSON.stringify({ event: "storage_metrics_unavailable" })),
    );
}, 60000);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(metrics);
  app.closeReviews();
  server.close(() => {
    void pool.end();
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
