import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const action = process.argv[2] ?? "serve";
const secret = async (name) =>
  (await readFile(`/run/secrets/${name}`, "utf8")).trim();
const role = action === "serve" ? "suiji_api" : "postgres";
const password = await secret(
  action === "serve" ? "api_password" : "db_password",
);
const connection = `postgresql://${role}:${encodeURIComponent(password)}@db:5432/suiji`;
const env = { ...process.env };
if (action === "serve") {
  env.DATABASE_URL = connection;
  delete env.MIGRATION_DATABASE_URL;
} else {
  env.MIGRATION_DATABASE_URL = connection;
  delete env.DATABASE_URL;
}
const commands = {
  serve: ["dist/index.js"],
  migrate: ["dist/migrate.js"],
  init: ["dist/admin.js", "init"],
  reset: ["dist/admin.js", "reset"],
};
if (!commands[action])
  throw new Error("Expected serve, migrate, init or reset");
// Compose secrets are root-readable mounts. Drop privileges before running any service code.
if (process.getuid?.() === 0) {
  process.setgid(1000);
  process.setuid(1000);
}
const child = spawn(process.execPath, commands[action], {
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
