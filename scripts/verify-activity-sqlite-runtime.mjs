import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  resourcesBackendDir,
  stagingAppDir,
} from "../electron/scripts/activity-sqlite-runtime-paths.mjs";

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "runweave-activity-runtime-"));
const electronExecutable = path.join(
  repoRoot,
  "node_modules",
  ".pnpm",
  "electron@33.4.11",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `symlink not allowed: ${absolute}`);
      if (entry.isDirectory()) return listFiles(root, absolute);
      return entry.isFile()
        ? [path.relative(root, absolute).split(path.sep).join("/")]
        : [];
    });
}

function verifyManifestTree(root, manifestFileName) {
  const manifest = JSON.parse(readFileSync(path.join(root, manifestFileName), "utf8"));
  const expectedPaths = manifest.files.map((file) => file.path).sort();
  const activityRoots = manifestFileName === "activity-sqlite-runtime-manifest.json"
    ? [
        manifest.workerEntry,
        "node_modules/better-sqlite3/",
        "node_modules/bindings/",
        "node_modules/file-uri-to-path/",
      ]
    : null;
  const actualPaths = listFiles(root).filter((file) =>
    file !== manifestFileName &&
    (!activityRoots || activityRoots.some((prefix) =>
      prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix,
    )),
  ).sort();
  assert.deepEqual(actualPaths, expectedPaths, "runtime manifest file set mismatch");
  for (const file of manifest.files) {
    const absolute = path.join(root, file.path);
    assert.equal(statSync(absolute).size, file.size, `${file.path} size mismatch`);
    assert.equal(
      crypto.createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      file.sha256,
      `${file.path} hash mismatch`,
    );
  }
  const treeSha256 = crypto.createHash("sha256")
    .update(manifest.files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n"))
    .digest("hex");
  assert.equal(treeSha256, manifest.treeSha256, "runtime tree hash mismatch");
  return manifest;
}

function runElectronWorker(
  workerEntry,
  databasePath,
  label,
  executable = electronExecutable,
) {
  const harnessPath = path.join(tempRoot, `${label}-worker-verify.cjs`);
  writeFileSync(
    harnessPath,
    `const {Worker}=require('node:worker_threads');
const crypto=require('node:crypto');
const worker=new Worker(${JSON.stringify(workerEntry)},{workerData:{databasePath:${JSON.stringify(databasePath)},contentKeyBase64:crypto.randomBytes(32).toString('base64')}});
let id=0;const pending=new Map();worker.on('message',(m)=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(new Error(m.error));});worker.on('error',(e)=>{throw e});
const request=(op)=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});worker.postMessage({...op,id:requestId});});
(async()=>{const now=new Date().toISOString();const event={eventId:crypto.randomUUID(),eventName:'producer.instance.started',schemaVersion:1,occurredAt:now,producer:{name:'runtime-verify',version:'1',instanceId:${JSON.stringify(label)},bootId:crypto.randomUUID(),bootStartedAt:now,sequence:1},actor:{type:'system'},runtime:{channel:'stable',surface:'backend'},scope:{},payload:{runtime:${JSON.stringify(label)}},contents:[],externalRefs:[]};await request({op:'record',events:[event]});const facts=await request({op:'facts',query:{limit:10}});if(facts.facts.length!==1)throw new Error('worker fact missing');if(!(await request({op:'integrity'})))throw new Error('worker integrity failed');const exited=new Promise((resolve)=>worker.once('exit',resolve));await request({op:'close'});await exited;console.log(JSON.stringify({facts:facts.facts.length,eventName:facts.facts[0].eventName}));})().catch((error)=>{console.error(error);process.exitCode=1;});`,
  );
  return JSON.parse(run(executable, [harnessPath], { ELECTRON_RUN_AS_NODE: "1" }));
}

try {
  const backendRequire = createRequire(
    path.join(repoRoot, "backend", "package.json"),
  );
  const nodePackageEntry = backendRequire.resolve("better-sqlite3");
  const nodeBinding = path.join(
    path.dirname(path.dirname(nodePackageEntry)),
    "build",
    "Release",
    "better_sqlite3.node",
  );
  const nodeDatabase = path.join(tempRoot, "node.sqlite");
  run(process.execPath, [
    "-e",
    `const Database=require(${JSON.stringify(nodePackageEntry)});const db=new Database(${JSON.stringify(nodeDatabase)});db.pragma('journal_mode=WAL');db.exec('CREATE TABLE verify(value TEXT)');db.prepare('INSERT INTO verify VALUES (?)').run('node');console.log(db.prepare('SELECT value FROM verify').get().value);db.close()`,
  ]);

  const electronManifestPath = path.join(
    resourcesBackendDir,
    "activity-sqlite-runtime-manifest.json",
  );
  assert.ok(existsSync(electronManifestPath), "Electron Activity manifest missing");
  const manifest = verifyManifestTree(
    resourcesBackendDir,
    "activity-sqlite-runtime-manifest.json",
  );
  const electronBinding = path.join(resourcesBackendDir, manifest.nativeBinding);
  assert.notEqual(path.resolve(nodeBinding), path.resolve(electronBinding));
  assert.ok(existsSync(electronBinding), "Electron native binding missing");

  const electronDatabase = path.join(tempRoot, "electron.sqlite");
  const workerEntry = path.join(resourcesBackendDir, manifest.workerEntry);
  const electronOutput = runElectronWorker(workerEntry, electronDatabase, "electron-runtime");

  const externalRootValue = process.env.RUNWEAVE_ACTIVITY_EXTERNAL_RELEASE?.trim();
  const externalRoot = externalRootValue ? path.resolve(externalRootValue) : null;
  let externalVerified = false;
  if (externalRoot) {
    verifyManifestTree(externalRoot, "manifest.json");
    const externalWorker = path.join(externalRoot, "backend", "activity-sqlite-worker.cjs");
    const externalBinding = path.join(
      externalRoot,
      "backend",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    assert.ok(existsSync(externalWorker));
    assert.ok(existsSync(externalBinding));
    runElectronWorker(
      externalWorker,
      path.join(tempRoot, "external.sqlite"),
      "external-runtime",
    );
    externalVerified = true;
  }

  const packagedResourcesValue = process.env.RUNWEAVE_ACTIVITY_PACKAGED_RESOURCES?.trim();
  const packagedResources = packagedResourcesValue
    ? path.resolve(packagedResourcesValue)
    : null;
  let packagedVerified = false;
  if (packagedResources) {
    const packagedBackend = path.join(packagedResources, "backend");
    const packagedManifest = verifyManifestTree(
      packagedBackend,
      "activity-sqlite-runtime-manifest.json",
    );
    const packagedWorker = path.join(packagedBackend, packagedManifest.workerEntry);
    const packagedExecutable = path.join(
      path.dirname(packagedResources),
      "MacOS",
      "Runweave",
    );
    runElectronWorker(
      packagedWorker,
      path.join(tempRoot, "packaged.sqlite"),
      "packaged-runtime",
      packagedExecutable,
    );
    packagedVerified = true;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        node: { packageEntry: nodePackageEntry, binding: nodeBinding },
        electron: {
          workerEntry,
          binding: electronBinding,
          output: electronOutput,
          stagingAppDir,
        },
        external: { verified: externalVerified },
        packaged: { verified: packagedVerified },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
