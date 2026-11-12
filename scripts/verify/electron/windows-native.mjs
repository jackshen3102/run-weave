// Run with ELECTRON_RUN_AS_NODE=1 <extracted>/Runweave.exe this-file <resources>.
// Exercise the distributed runtime without starting a Server or touching user data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requirePackage = createRequire(import.meta.url);
const filename = fileURLToPath(import.meta.url);
assert.ok(process.versions.electron, "Run this check with packaged Electron");
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const resources = path.resolve(process.argv[2]);
const lock = requirePackage(
  path.join(resources, "node_modules/fs-native-extensions"),
);

if (process.argv[3] === "--lock-probe") {
  const fd = fs.openSync(process.argv[4], "r+");
  const acquired = lock.tryLock(fd);
  if (acquired) lock.unlock(fd);
  fs.closeSync(fd);
  process.exit(acquired ? 0 : 2);
}

async function main() {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "runweave-windows-native-"),
  );
  try {
    console.log("Verifying packaged resources and SQLite manifest");
    for (const file of [
      "app.asar/dist/main.cjs",
      "frontend/dist/index.html",
      "configuration-compatibility.json",
      "backend/activity-sqlite-worker.cjs",
    ])
      assert.ok(fs.statSync(path.join(resources, file)).size > 0, file);

    const backend = path.join(resources, "backend");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(backend, "activity-sqlite-runtime-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.arch, process.arch);
    assert.equal(manifest.electronVersion, process.versions.electron);
    assert.ok(manifest.files.length > 0, "Native manifest must not be empty");
    for (const file of manifest.files) {
      const data = fs.readFileSync(path.join(backend, file.path));
      assert.equal(data.length, file.size, file.path);
      assert.equal(
        createHash("sha256").update(data).digest("hex"),
        file.sha256,
        file.path,
      );
    }

    console.log("Verifying SQLite persistence and integrity");
    const Database = requirePackage(
      path.join(backend, "node_modules/better-sqlite3"),
    );
    const dbPath = path.join(scratch, "smoke.sqlite");
    let db = new Database(dbPath);
    db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
    db.prepare("INSERT INTO smoke VALUES (?)").run(
      "windows-electron-persistence",
    );
    db.close();
    db = new Database(dbPath);
    assert.equal(
      db.prepare("SELECT value FROM smoke").get().value,
      "windows-electron-persistence",
    );
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    db.close();

    console.log("Verifying cross-process native locks");
    const fd = fs.openSync(path.join(scratch, "smoke.lock"), "w+");
    try {
      const probe = () =>
        spawnSync(
          process.execPath,
          [
            filename,
            resources,
            "--lock-probe",
            path.join(scratch, "smoke.lock"),
          ],
          { timeout: 15_000, windowsHide: true },
        );
      assert.equal(lock.tryLock(fd), true);
      assert.equal(
        probe().status,
        2,
        "Other process must not acquire held lock",
      );
      lock.unlock(fd);
      assert.equal(
        probe().status,
        0,
        "Other process must acquire released lock",
      );
    } finally {
      fs.closeSync(fd);
    }

    // Resolving from the extracted ZIP catches missing hoisted transitive modules.
    console.log("Verifying Whistle module graph");
    requirePackage(
      path.join(resources, "whistle-runtime/node_modules/whistle"),
    );

    console.log("Verifying packaged Windows PTY");
    const pty = requirePackage(path.join(backend, "node_modules/node-pty"));
    await new Promise((resolve, reject) => {
      const terminal = pty.spawn(
        "cmd.exe",
        [
          "/d",
          "/q",
          "/v:on",
          "/c",
          "echo PTY_READY & set /p RW_INPUT= & echo IO:!RW_INPUT! & exit /b 7",
        ],
        {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: scratch,
          env: process.env,
        },
      );
      let output = "";
      let sent = false;
      const timer = setTimeout(() => {
        terminal.kill();
        reject(new Error("Packaged Windows PTY timed out"));
      }, 20_000);
      terminal.onData((chunk) => {
        output += chunk;
        if (!sent && output.includes("PTY_READY")) {
          sent = true;
          terminal.resize(100, 40);
          terminal.write("packaged-electron\r");
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        try {
          assert.equal(exitCode, 7);
          assert.match(output, /IO:packaged-electron/);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          electron: process.versions.electron,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          checks: [
            "packaged resources",
            "SQLite manifest hashes",
            "SQLite persistence/integrity",
            "cross-process native locks",
            "Whistle module graph",
            "PTY spawn/I/O/resize/exit",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
// Whistle initializes background timers during require; end after cleanup.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
