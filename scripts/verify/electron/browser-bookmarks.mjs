import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BookmarkStore } from "../../../electron/src/browser/bookmarks/store.ts";
const root = mkdtempSync(path.join(tmpdir(), "runweave-bookmarks-"));
const report = [];
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const writer = (file, snapshot) => {
  writeFileSync(file + ".tmp", JSON.stringify(snapshot, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(file + ".tmp", file);
};
const fixture = (name) => {
  const dir = path.join(root, name);
  mkdirSync(dir);
  const file = path.join(dir, "bookmarks.json");
  return { file, store: new BookmarkStore(file, writer) };
};
const add = (store, title, url, parentId = null) => {
  const read = store.read();
  assert.equal(read.ok, true);
  return store.mutate({
    expectedRevision: read.snapshot.revision,
    operation: { kind: "add-link", title, url, parentId, faviconDataUrl: null },
  });
};
const success = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
try {
  const f = fixture("restart");
  success(add(f.store, "A", "https://example.com/?a=1#part"));
  const base = success(f.store.read()).snapshot;
  const reloaded = new BookmarkStore(f.file, writer);
  assert.deepEqual(success(reloaded.read()).snapshot, base);
  report.push("BKI-001: actual file reload preserves committed data");
  const a = success(add(f.store, "B", "https://example.org/"));
  const rev = a.snapshot.revision;
  const first = f.store.mutate({
    expectedRevision: rev,
    operation: { kind: "set-bar-visible", visible: false },
  });
  const second = f.store.mutate({
    expectedRevision: rev,
    operation: { kind: "set-bar-visible", visible: true },
  });
  success(first);
  assert.equal(second.error.code, "REVISION_CONFLICT");
  assert.equal(JSON.parse(readFileSync(f.file)).revision, rev + 1);
  const retry = success(
    f.store.mutate({
      expectedRevision: success(f.store.read()).snapshot.revision,
      operation: { kind: "add-folder", title: "retry" },
    }),
  );
  assert.equal(retry.snapshot.barVisible, false);
  assert.equal(
    retry.snapshot.entries.some(
      (e) => e.kind === "folder" && e.title === "retry",
    ),
    true,
  );
  report.push(
    "BKI-002: stale revision rejected; explicit reread and retry preserves first commit",
  );
  const fail = fixture("write-failure");
  success(add(fail.store, "A", "https://a.test/"));
  const before = hash(fail.file);
  let failWrites = true;
  const failStore = new BookmarkStore(fail.file, (file, snapshot) => {
    if (failWrites) writer(path.join(root, "missing", "cannot-write.json"), {});
    else writer(file, snapshot);
  });
  const snap = success(failStore.read()).snapshot;
  const denied = failStore.mutate({
    expectedRevision: snap.revision,
    operation: { kind: "set-bar-visible", visible: false },
  });
  assert.equal(denied.error.code, "STORE_UNAVAILABLE");
  assert.equal(hash(fail.file), before);
  assert.deepEqual(success(failStore.read()).snapshot, snap);
  failWrites = false;
  assert.equal(
    success(
      failStore.mutate({
        expectedRevision: snap.revision,
        operation: { kind: "set-bar-visible", visible: false },
      }),
    ).snapshot.barVisible,
    false,
  );
  assert.equal(JSON.parse(readFileSync(fail.file)).barVisible, false);
  report.push(
    "BKI-003: filesystem failure preserves state; restored writer accepts explicit retry",
  );
  for (const [name, raw, code] of [
    ["json", "{bad", "STORE_UNAVAILABLE"],
    [
      "unknown",
      JSON.stringify({ ...base, schemaVersion: 2 }),
      "UNSUPPORTED_SCHEMA",
    ],
    ["orphan", JSON.stringify({ ...base, rootIds: [] }), "STORE_UNAVAILABLE"],
    [
      "duplicate-reference",
      JSON.stringify({ ...base, rootIds: [...base.rootIds, ...base.rootIds] }),
      "STORE_UNAVAILABLE",
    ],
  ]) {
    const bad = fixture(name);
    writeFileSync(bad.file, raw);
    const original = hash(bad.file);
    const result = bad.store.read();
    assert.equal(result.error.code, code);
    assert.equal(
      bad.store.mutate({
        expectedRevision: 0,
        operation: { kind: "add-folder", title: "new" },
      }).ok,
      false,
    );
    assert.equal(hash(bad.file), original);
    writer(bad.file, base);
    assert.deepEqual(success(bad.store.read()).snapshot, base);
  }
  report.push(
    "BKI-004: corrupt and future schema preserved, explicit read recovers",
  );
  const v = fixture("validation");
  const initial = success(add(v.store, "A", "https://example.com/?a=1#part"));
  const id = initial.affectedId;
  assert.equal(
    success(add(v.store, "Again", "https://example.com/?a=1#part")).affectedId,
    id,
  );
  const original = hash(v.file);
  for (const url of [
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "file:///tmp/secret",
    "https://example.com/" + "x".repeat(8192),
  ]) {
    assert.equal(add(v.store, "bad", url).error.code, "INVALID_INPUT");
    assert.equal(hash(v.file), original);
  }
  assert.equal(add(v.store, " ".repeat(5), "https://valid.test/").ok, false);
  assert.equal(add(v.store, "x".repeat(201), "https://valid.test/").ok, false);
  const folder = success(
    v.store.mutate({
      expectedRevision: initial.snapshot.revision,
      operation: { kind: "add-folder", title: "F" },
    }),
  );
  const nested = v.store.mutate({
    expectedRevision: folder.snapshot.revision,
    operation: {
      kind: "move",
      id: folder.affectedId,
      parentId: folder.affectedId,
      beforeId: null,
    },
  });
  assert.equal(nested.ok, false);
  const other = success(add(v.store, "B", "https://b.test/"));
  const invariant = hash(v.file);
  const invalid = [
    {
      kind: "edit-link",
      id: other.affectedId,
      title: "B",
      url: "https://example.com/?a=1#part",
      parentId: null,
    },
    { kind: "move", id: other.affectedId, parentId: "missing", beforeId: null },
    { kind: "move", id: other.affectedId, parentId: id, beforeId: null },
    {
      kind: "move",
      id: other.affectedId,
      parentId: folder.affectedId,
      beforeId: id,
    },
    {
      kind: "add-link",
      title: "SVG",
      url: "https://icon.test/",
      parentId: null,
      faviconDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    },
  ];
  for (const [index, operation] of invalid.entries()) {
    const out = v.store.mutate({
      expectedRevision: other.snapshot.revision,
      operation,
    });
    assert.equal(
      out.error.code,
      index === 0 ? "DUPLICATE_URL" : "INVALID_INPUT",
    );
    assert.equal(hash(v.file), invariant);
    assert.equal(
      success(v.store.read()).snapshot.revision,
      other.snapshot.revision,
    );
  }
  assert.equal(
    other.snapshot.entries.find((e) => e.id === id).url,
    "https://example.com/?a=1#part",
  );
  report.push(
    "BKI-005: URL, duplicate edit, invalid parent/before and SVG invariants",
  );
  const limit = fixture("limit");
  const entries = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i),
    kind: "link",
    title: "Item " + i,
    url: `https://limit.test/${i}`,
    faviconDataUrl: null,
  }));
  const large = {
    schemaVersion: 1,
    revision: 1,
    barVisible: true,
    rootIds: entries.map((e) => e.id),
    entries,
  };
  writer(limit.file, large);
  const originalLimit = hash(limit.file);
  assert.equal(
    add(limit.store, "overflow", "https://limit.test/overflow").error.code,
    "LIMIT_EXCEEDED",
  );
  assert.equal(hash(limit.file), originalLimit);
  const fat = fixture("byte-limit");
  const png = "data:image/png;base64," + "A".repeat(7900);
  const fatEntries = entries
    .slice(0, 2100)
    .map((e) => ({ ...e, faviconDataUrl: png }));
  const near = {
    ...large,
    rootIds: fatEntries.map((e) => e.id),
    entries: fatEntries,
  };
  while (
    Buffer.byteLength(JSON.stringify(near, null, 2) + "\n") >
    16 * 1024 * 1024
  ) {
    near.entries.pop();
    near.rootIds.pop();
  }
  writer(fat.file, near);
  const fatBefore = hash(fat.file);
  let reached = false;
  for (let i = 0; i < 3; i++) {
    const out = fat.store.mutate({
      expectedRevision: success(fat.store.read()).snapshot.revision,
      operation: {
        kind: "add-link",
        title: "extra",
        url: `https://extra.test/${i}`,
        parentId: null,
        faviconDataUrl: png,
      },
    });
    if (!out.ok) {
      assert.equal(out.error.code, "LIMIT_EXCEEDED");
      reached = true;
      break;
    }
  }
  assert.equal(reached, true);
  assert.equal(hash(fat.file), fatBefore);
  for (const boundary of [limit, fat]) {
    const snapshot = success(boundary.store.read()).snapshot;
    const smaller = success(
      boundary.store.mutate({
        expectedRevision: snapshot.revision,
        operation: {
          kind: "delete",
          id: snapshot.rootIds[0],
          includeChildren: false,
        },
      }),
    );
    assert.equal(smaller.snapshot.entries.length, snapshot.entries.length - 1);
    assert.equal(
      JSON.parse(readFileSync(boundary.file)).entries.length,
      smaller.snapshot.entries.length,
    );
  }
  report.push(
    "BKI-006: count/byte overflow rejected; boundary reduction still succeeds",
  );
  const order = fixture("order");
  const one = success(add(order.store, "One", "https://one.test/"));
  const two = success(add(order.store, "Two", "https://two.test/"));
  const folderResult = success(
    order.store.mutate({
      expectedRevision: two.snapshot.revision,
      operation: { kind: "add-folder", title: "Folder" },
    }),
  );
  let moved = success(
    order.store.mutate({
      expectedRevision: folderResult.snapshot.revision,
      operation: {
        kind: "move",
        id: one.affectedId,
        parentId: folderResult.affectedId,
        beforeId: null,
      },
    }),
  );
  assert.equal(moved.snapshot.rootIds.includes(one.affectedId), false);
  assert.deepEqual(
    moved.snapshot.entries.find((e) => e.id === folderResult.affectedId)
      .children,
    [one.affectedId],
  );
  const decline = order.store.mutate({
    expectedRevision: moved.snapshot.revision,
    operation: {
      kind: "delete",
      id: folderResult.affectedId,
      includeChildren: false,
    },
  });
  assert.equal(decline.ok, false);
  const removed = success(
    order.store.mutate({
      expectedRevision: moved.snapshot.revision,
      operation: {
        kind: "delete",
        id: folderResult.affectedId,
        includeChildren: true,
      },
    }),
  );
  assert.deepEqual(removed.snapshot.rootIds, [two.affectedId]);
  report.push("BKM-003/004: atomic folder move and confirmed cascade delete");
  console.log(JSON.stringify({ ok: true, report }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
