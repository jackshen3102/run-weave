// Rebuild only the packaged SQLite addon against the oldest supported Linux libc.
// Upstream better-sqlite3 prebuilds currently require glibc 2.34 / GLIBCXX 3.4.29.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const linuxRuntimeImage = "node:22.23.2-bullseye";

export function prepareLinuxSqlite(source, target) {
  if (process.platform !== "linux") return;
  const directory = mkdtempSync(path.join(tmpdir(), "runweave-linux-sqlite-"));
  try {
    for (const name of ["package.json", "binding.gyp", "src", "deps", "lib"]) {
      cpSync(path.join(source, name), path.join(directory, name), { recursive: true });
    }
    const result = spawnSync("docker", [
      "run", "--rm", "--platform", `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
      "--user", `${process.getuid()}:${process.getgid()}`,
      "--env", "HOME=/tmp/build-home", "--volume", `${directory}:/build`,
      "--workdir", "/build", linuxRuntimeImage, "sh", "-eu", "-c", `
        npm install --ignore-scripts --omit=dev --no-package-lock --registry=https://registry.npmjs.org/
        npm exec --yes --registry=https://registry.npmjs.org/ --package=node-gyp@10.3.1 -- node-gyp rebuild --release --force_build=1 --nodedir=/usr/local
        node -e 'const Database=require("./lib"); const db=new Database(":memory:"); db.exec("CREATE TABLE sample(value TEXT) STRICT"); db.prepare("INSERT INTO sample VALUES (?)").run("ok"); if(db.prepare("SELECT value FROM sample").get().value!=="ok") throw Error("SQLite roundtrip failed"); db.close(); console.log("SQLite glibc baseline:",process.report.getReport().header.glibcVersionRuntime)'
      `,
    ], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Linux SQLite compatibility build failed");
    cpSync(path.join(directory, "build/Release/better_sqlite3.node"),
      path.join(target, "prebuilds", `linux-${process.arch}.node`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
