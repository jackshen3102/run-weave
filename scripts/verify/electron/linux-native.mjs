// Run with ELECTRON_RUN_AS_NODE=1 <linux-unpacked>/runweave this-file <resources>.
// This is a packaged-runtime integration check, not a host-Node binding test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const requirePackage = createRequire(import.meta.url);
const filename = fileURLToPath(import.meta.url);

assert.ok(process.versions.electron, "Run this check with packaged Electron");
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
const resources = path.resolve(process.argv[2]);
const lock = requirePackage(path.join(resources, "node_modules/fs-native-extensions"));
if (process.argv[3] === "--lock-probe") {
  const fd = fs.openSync(process.argv[4], "r+");
  const acquired = lock.tryLock(fd);
  if (acquired) lock.unlock(fd);
  fs.closeSync(fd);
  process.exit(acquired ? 0 : 2);
}

async function main() {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "runweave-linux-native-"),
  );
  try {
    const backend = path.join(resources, "backend");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(backend, "activity-sqlite-runtime-manifest.json"),
      ),
    );
    assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.arch, process.arch);
    assert.equal(manifest.electronVersion, process.versions.electron);
    for (const file of manifest.files) {
      const data = fs.readFileSync(path.join(backend, file.path));
      assert.equal(data.length, file.size, file.path);
      assert.equal(
        createHash("sha256").update(data).digest("hex"),
        file.sha256,
        file.path,
      );
    }
    const Database = requirePackage(path.join(backend, "node_modules/better-sqlite3"));
    const dbPath = path.join(scratch, "smoke.sqlite");
    let db = new Database(dbPath);
    db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
    db.prepare("INSERT INTO smoke VALUES (?)").run(
      "linux-electron-persistence",
    );
    db.close();
    db = new Database(dbPath);
    assert.equal(
      db.prepare("SELECT value FROM smoke").get().value,
      "linux-electron-persistence",
    );
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    db.close();

    const lockPath = path.join(scratch, "smoke.lock");
    const fd = fs.openSync(lockPath, "w+");
    const probe = () =>
      spawnSync(
        process.execPath,
        [filename, resources, "--lock-probe", lockPath],
        { env: process.env },
      );
    assert.equal(lock.tryLock(fd), true);
    assert.equal(probe().status, 2, "Other process must not acquire held lock");
    lock.unlock(fd);
    assert.equal(probe().status, 0, "Other process must acquire released lock");
    fs.closeSync(fd);

    const pty = requirePackage(path.join(backend, "node_modules/node-pty"));
    await new Promise((resolve, reject) => {
      const terminal = pty.spawn(
        "/bin/sh",
        [
          "-c",
          'printf "PTY_READY\\n"; read value; stty size; printf "IO:%s\\n" "$value"; exit 7',
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
        reject(new Error("PTY timed out"));
      }, 10000);
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
          assert.match(output, /40 100/);
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
            "sqlite manifest hashes",
            "sqlite persistence/integrity",
            "cross-process native locks",
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
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
