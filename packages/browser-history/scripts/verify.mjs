// Integration verification against real files and the bundled native stdio process.
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  appendFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const base = fileURLToPath(new URL("../dist/", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "runweave-history-verify-"));
const id = "abcdefghijklmnopabcdefghijklmnop",
  origin = `chrome-extension://${id}/`;
let host;
try {
  host = spawn(
    process.execPath,
    [
      path.join(base, "native-host.cjs"),
      "--root",
      root,
      "--browser",
      "chrome",
      "--allowed-id",
      id,
      origin,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = Buffer.alloc(0),
    waiting = [];
  host.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0),
        value = JSON.parse(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
      waiting.shift()?.(value);
    }
  });
  const request = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("HOST_TIMEOUT")), 5000);
      waiting.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
      const body = Buffer.from(
        JSON.stringify({ version: 1, id: randomUUID(), ...message }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      host.stdin.write(Buffer.concat([header, body]));
    });
  const sourceId = randomUUID();
  assert.equal(
    (await request({ op: "hello", sourceId, profileLabel: "Chrome fixture" }))
      .ok,
    true,
  );
  const visit = {
    schemaVersion: 1,
    sourceId,
    browser: "chrome",
    visitId: randomUUID(),
    revision: 1,
    visitedAt: "2026-10-24T16:00:00.000Z",
    observedAt: "2026-10-24T16:00:01.000Z",
    url: "https://example.com/a",
    title: null,
    navigation: "document",
    profileLabel: "Chrome fixture",
    actor: "unknown",
  };
  assert.equal((await request({ op: "append", rows: [visit] })).ok, true);
  assert.equal((await request({ op: "append", rows: [visit] })).ok, true);
  const reordered = Object.fromEntries(
    Object.entries(visit).sort(([a], [b]) => a.localeCompare(b)),
  );
  assert.equal((await request({ op: "append", rows: [reordered] })).ok, true);
  const update = {
    ...visit,
    revision: 2,
    title: "延迟标题",
    observedAt: "2026-10-26T01:00:00.000Z",
  };
  assert.equal((await request({ op: "append", rows: [update] })).ok, true);
  assert.equal(
    (
      await request({
        op: "append",
        rows: [
          {
            ...visit,
            visitId: randomUUID(),
            visitedAt: "2026-10-24T15:59:59.999Z",
          },
          {
            ...visit,
            visitId: randomUUID(),
            visitedAt: "2026-10-25T16:00:00.000Z",
          },
        ],
      })
    ).ok,
    true,
  );
  const secondSource = randomUUID();
  const frame = (message) => {
    const body = Buffer.from(
      JSON.stringify({ version: 1, id: randomUUID(), ...message }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  };
  const second = execFileSync(
    process.execPath,
    [
      path.join(base, "native-host.cjs"),
      "--root",
      root,
      "--browser",
      "edge",
      "--allowed-id",
      id,
      origin,
    ],
    {
      input: Buffer.concat([
        frame({
          op: "hello",
          sourceId: secondSource,
          profileLabel: "Edge fixture",
        }),
        frame({
          op: "append",
          rows: [
            {
              ...visit,
              sourceId: secondSource,
              browser: "edge",
              profileLabel: "Edge fixture",
            },
          ],
        }),
      ]),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assert.ok(second.toString().includes('"ok":true'));
  assert.equal(
    (
      await request({
        op: "append",
        rows: [{ ...visit, sourceId: "../escape" }],
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await request({
        op: "append",
        rows: [{ ...visit, url: "https://example.com/a?token=simulated" }],
      })
    ).ok,
    false,
  );
  assert.equal(
    (await request({ op: "execute", command: "echo unsafe" })).ok,
    false,
  );
  const run = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(base, "cli.cjs"), ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  const out = path.join(root, "output");
  assert.equal(
    run(
      "collect",
      "--root",
      root,
      "--from",
      "2026-10-25",
      "--to",
      "2026-10-25",
      "--out",
      out,
    ).visits,
    2,
  );
  const materials = (await readFile(path.join(out, "visits.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const material = materials.find((m) => m.visit.sourceId === sourceId);
  assert.equal(material.visit.title, "延迟标题");
  assert.equal(
    run("read", "--bundle", out, "--id", material.id, "--verify-source")
      .verifiedSource,
    true,
  );
  assert.equal(
    (await stat(path.join(out, "visits.jsonl"))).mode & 0o777,
    0o600,
  );
  const manifest = JSON.parse(
    await readFile(path.join(out, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.coverage, "observed-only");
  for (const file of manifest.files) {
    const before = await readFile(path.join(root, file.file));
    run("read", "--bundle", out, "--id", material.id, "--verify-source");
    assert.deepEqual(await readFile(path.join(root, file.file)), before);
  }
  assert.throws(() =>
    run(
      "collect",
      "--root",
      root,
      "--from",
      "2026-10-25",
      "--to",
      "2026-10-25",
      "--out",
      out,
    ),
  );
  const stream = (
    await readdir(path.join(root, "sources", sourceId))
  )[0].replace(/\.json$/, ".jsonl");
  await appendFile(path.join(root, "streams", stream), '{"unfinished":');
  assert.throws(
    () =>
      run(
        "collect",
        "--root",
        root,
        "--from",
        "2026-10-25",
        "--to",
        "2026-10-25",
        "--out",
        path.join(root, "partial"),
      ),
    (e) => e.status === 2,
  );
  const partial = JSON.parse(
    await readFile(path.join(root, "partial/manifest.json"), "utf8"),
  );
  assert.equal(
    partial.receipts.find((r) => r.sourceId === sourceId).readStatus,
    "partial",
  );
  await appendFile(
    path.join(root, "streams", stream),
    "\nnot-json\n" + JSON.stringify({ ...visit, schemaVersion: 2 }) + "\n",
  );
  assert.throws(
    () =>
      run(
        "collect",
        "--root",
        root,
        "--from",
        "2026-10-25",
        "--to",
        "2026-10-25",
        "--out",
        path.join(root, "future"),
      ),
    (e) => e.status === 2,
  );
  const future = JSON.parse(
    await readFile(path.join(root, "future/manifest.json"), "utf8"),
  );
  assert.ok(
    future.receipts
      .find((r) => r.sourceId === sourceId)
      .issues.some((i) => i.includes("UNSUPPORTED_HISTORY_SCHEMA")),
  );
  const missingStream = (
    await readdir(path.join(root, "sources", secondSource))
  )[0].replace(/\.json$/, ".jsonl");
  await rm(path.join(root, "streams", missingStream));
  assert.throws(
    () =>
      run(
        "collect",
        "--root",
        root,
        "--from",
        "2026-10-25",
        "--to",
        "2026-10-25",
        "--out",
        path.join(root, "missing-stream"),
      ),
    (e) => e.status === 2,
  );
  const missing = JSON.parse(
    await readFile(path.join(root, "missing-stream/manifest.json"), "utf8"),
  );
  assert.equal(
    missing.receipts.find((r) => r.sourceId === secondSource).readStatus,
    "unavailable",
  );
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(256 * 1024 + 1);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(base, "native-host.cjs"),
          "--root",
          root,
          "--browser",
          "chrome",
          "--allowed-id",
          id,
          origin,
        ],
        { input: oversized, stdio: ["pipe", "pipe", "pipe"] },
      ),
    (e) => e.status === 1 && e.stderr.toString().includes("FRAME_TOO_LARGE"),
  );
  const missingRoot = path.join(root, "missing");
  assert.throws(
    () =>
      run(
        "collect",
        "--root",
        missingRoot,
        "--from",
        "2026-10-25",
        "--to",
        "2026-10-25",
        "--out",
        path.join(root, "no-sources"),
      ),
    (e) => e.status === 2,
  );
  // Registration copies the runnable host; it must survive deleting the original staging directory.
  if (process.platform === "darwin") {
    const installRoot = path.join(root, "installed"),
      home = path.join(root, "home");
    const installed = run(
      "native-install",
      "--root",
      installRoot,
      "--home",
      home,
      "--browser",
      "chrome",
      "--extension-id",
      id,
    );
    const invalid = spawn(installed.launcher, [
      "chrome-extension://pppppppppppppppppppppppppppppppp/",
    ]);
    const exit = await new Promise((resolve) => invalid.on("exit", resolve));
    assert.equal(exit, 1);
    await writeFile(path.join(installRoot, "keep.json"), "{}");
    assert.equal(
      run(
        "native-uninstall",
        "--root",
        installRoot,
        "--home",
        home,
        "--browser",
        "chrome",
      ).dataPreserved,
      true,
    );
    assert.equal(
      await readFile(path.join(installRoot, "keep.json"), "utf8"),
      "{}",
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "native ACK after write",
        "original-key replay",
        "reordered-key replay",
        "late revision",
        "source and URL validation",
        "operation restriction",
        "Shanghai date window",
        "cross-source same-URL preservation",
        "readback hash",
        "private mode",
        "existing output protection",
        "partial tail and invalid JSON",
        "future schema explicit status",
        "registered missing stream unavailable",
        "oversized native frame",
        "unregistered coverage partial",
        "macOS host install and origin restriction",
      ],
    }),
  );
} finally {
  host?.stdin.end();
  host?.kill();
  await rm(root, { recursive: true, force: true });
}
