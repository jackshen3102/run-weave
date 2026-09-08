import { chmod, chown, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
const action = process.argv[2] ?? "serve";
const codexAction = action === "codex-login" || action === "codex-status";
const commands = {
  serve: ["dist/index.js"],
  migrate: ["dist/migrate.js"],
  init: ["dist/admin.js", "init"],
  reset: ["dist/admin.js", "reset"],
  "codex-login": [
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
    "--device-auth",
  ],
  "codex-status": [
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
    "status",
  ],
};
if (!Object.hasOwn(commands, action))
  throw new Error(
    "Expected serve, migrate, init, reset, codex-login or codex-status",
  );
const env = { ...process.env };
const secret = async (name) =>
  (await readFile(`/run/secrets/${name}`, "utf8")).trim();
delete env.DATABASE_URL;
delete env.MIGRATION_DATABASE_URL;
if (!codexAction) {
  const role = action === "serve" ? "suiji_api" : "postgres";
  const password = await secret(
    action === "serve" ? "api_password" : "db_password",
  );
  const connection = `postgresql://${role}:${encodeURIComponent(password)}@db:5432/suiji`;
  env[action === "serve" ? "DATABASE_URL" : "MIGRATION_DATABASE_URL"] =
    connection;
}
if (
  codexAction ||
  (action === "serve" && env.SUIJI_AI_PROVIDER === "codex-cli")
) {
  const directory = env.SUIJI_CODEX_HOME;
  if (!directory || !path.isAbsolute(directory))
    throw new Error("Codex requires an absolute SUIJI_CODEX_HOME");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) await chown(directory, 1000, 1000);
  await chmod(directory, 0o700);
  if (codexAction) env.CODEX_HOME = directory;
}
// Compose secrets are root-readable mounts. Drop privileges before running any service code.
if (process.getuid?.() === 0) {
  process.setgid(1000);
  process.setuid(1000);
}
const child = spawn(
  codexAction ? "codex" : process.execPath,
  commands[action],
  {
    env,
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
