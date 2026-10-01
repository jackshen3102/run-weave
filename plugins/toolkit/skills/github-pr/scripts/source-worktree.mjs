#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Capture before copying/staging. Receipts contain recovery data, never stdout.
const env = { ...process.env };
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
])
  delete env[key];
env.GIT_OPTIONAL_LOCKS = "0";
function git(cwd, args, optional = false) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (optional && !result.error) return null;
    throw new Error(result.error?.message ?? result.stderr.trim());
  }
  return result.stdout;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const split = (value) => value.split("\0").filter(Boolean);
function tree(cwd, revision) {
  return Object.fromEntries(
    split(git(cwd, ["ls-tree", "-r", "-z", revision])).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, , oid] = entry.slice(0, tab).split(" ");
      return [entry.slice(tab + 1), { mode, oid }];
    }),
  );
}
function state(cwd) {
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const baseline = tree(cwd, head);
  const indexPath = path.resolve(
    cwd,
    git(cwd, ["rev-parse", "--git-path", "index"]).trim(),
  );
  const index = fs.readFileSync(indexPath).toString("base64");
  const entries = Object.fromEntries(
    split(git(cwd, ["ls-files", "--stage", "-z"])).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, oid, stage] = entry.slice(0, tab).split(" ");
      if (stage !== "0")
        throw new Error("Unmerged index; retain source worktree");
      return [entry.slice(tab + 1), { mode, oid }];
    }),
  );
  const names = new Set([
    ...split(git(cwd, ["diff", "HEAD", "--name-only", "--no-renames", "-z"])),
    ...split(
      git(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"]),
    ),
    ...split(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
  const fileMode =
    git(cwd, ["config", "--get", "core.filemode"], true)?.trim() !== "false";
  const files = {};
  for (const name of [...names].sort()) {
    const full = path.join(cwd, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!stat) {
      files[name] = { working: null, index: entries[name] ?? null };
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Unsupported path: ${name}`);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(full))
      : fs.readFileSync(full);
    const mode = stat.isSymbolicLink()
      ? "120000"
      : !fileMode && entries[name]
        ? entries[name].mode
        : stat.mode & 0o111
          ? "100755"
          : "100644";
    const oid = stat.isSymbolicLink()
      ? spawnSync("git", ["-C", cwd, "hash-object", "--stdin"], {
          env,
          input: bytes,
          encoding: "utf8",
        })
      : { status: 0, stdout: git(cwd, ["hash-object", "--", name]) };
    if (oid.status !== 0) throw new Error(`Cannot hash ${name}`);
    files[name] = {
      working: { mode, oid: oid.stdout.trim() },
      index: entries[name] ?? null,
      rawSHA256: digest(bytes),
      data: bytes.toString("base64"),
      permissions: stat.mode & 0o777,
      tracked: Boolean(baseline[name]),
    };
  }
  return { head, indexPath, index, files };
}
const equal = (left, right) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
function inspect(receipt, targetRef) {
  const cwd = receipt.cwd;
  if (
    fs.realpathSync(
      path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()),
    ) !== receipt.repository
  ) {
    throw new Error("Source repository identity changed");
  }
  const target = git(cwd, [
    "rev-parse",
    "--verify",
    `${targetRef}^{commit}`,
  ]).trim();
  const current = state(cwd),
    targetTree = tree(cwd, target);
  const changed = [
    ...new Set([
      ...Object.keys(receipt.snapshot.files),
      ...Object.keys(current.files),
    ]),
  ].filter((name) => !equal(receipt.snapshot.files[name], current.files[name]));
  const covered = [],
    retained = [];
  for (const [name, file] of Object.entries(current.files)) {
    if (
      receipt.ownedPaths.includes(name) &&
      equal(file.working, targetTree[name])
    )
      covered.push(name);
    else retained.push(name);
  }
  const base = git(cwd, ["merge-base", current.head, target]).trim();
  const sourceTree = tree(cwd, current.head);
  const historyUncovered = split(
    git(cwd, ["diff", "--name-only", "--no-renames", "-z", base, current.head]),
  ).filter(
    (name) =>
      !equal(
        covered.includes(name) ? current.files[name].working : sourceTree[name],
        targetTree[name],
      ),
  );
  // A staged version differing from the final working file is a separate payload.
  const indexUncovered = covered.filter((name) => {
    const file = current.files[name];
    return (
      !equal(file.index, sourceTree[name]) && !equal(file.index, file.working)
    );
  });
  return {
    target,
    current,
    covered,
    retained,
    changed,
    historyUncovered,
    indexUncovered,
    canFinish:
      current.head === receipt.snapshot.head &&
      current.index === receipt.snapshot.index &&
      changed.length === 0 &&
      historyUncovered.length === 0 &&
      indexUncovered.length === 0,
  };
}
function restoreIndex(snapshot) {
  const lock = `${snapshot.indexPath}.lock`;
  fs.writeFileSync(lock, Buffer.from(snapshot.index, "base64"), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(lock, snapshot.indexPath);
}
function finish(receipt, audit, receiptPath) {
  if (!audit.canFinish)
    throw new Error(
      "Source changed or contains unpublished history/index content; inspect receipt and retain source",
    );
  const cwd = receipt.cwd,
    snapshot = audit.current;
  const backupRef = `refs/heads/backup/pr-source-${randomUUID()}`;
  git(cwd, [
    "update-ref",
    backupRef,
    snapshot.head,
    "0".repeat(snapshot.head.length),
  ]);
  // Re-check before entering rollback: a changed source must never be restored.
  if (!equal(state(cwd), snapshot))
    throw new Error("Source changed before synchronization");
  const removed = [];
  let stagedIndex;
  try {
    for (const name of audit.covered) {
      const file = snapshot.files[name];
      if (!file.tracked && !file.index) {
        fs.unlinkSync(path.join(cwd, name));
        removed.push(name);
      } else {
        git(cwd, ["add", "--", name]);
      }
    }
    stagedIndex = fs.readFileSync(snapshot.indexPath).toString("base64");
    // No --force, reset, clean or stash: Git refuses overlapping residual edits.
    git(cwd, ["checkout", "--detach", audit.target]);
  } catch (error) {
    if (git(cwd, ["rev-parse", "HEAD"]).trim() === snapshot.head) {
      if (
        stagedIndex &&
        fs.readFileSync(snapshot.indexPath).toString("base64") !== stagedIndex
      ) {
        throw new Error(
          `Index changed; retain recovery receipt ${receiptPath}: ${error.message}`,
        );
      }
      restoreIndex(snapshot);
      for (const name of removed) {
        const file = snapshot.files[name],
          full = path.join(cwd, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (file.working.mode === "120000")
          fs.symlinkSync(Buffer.from(file.data, "base64").toString(), full);
        else
          fs.writeFileSync(full, Buffer.from(file.data, "base64"), {
            flag: "wx",
            mode: file.permissions,
          });
      }
    }
    throw new Error(
      `Synchronization incomplete; backup ${backupRef}, receipt ${receiptPath}: ${error.message}`,
    );
  }
  const after = state(cwd);
  const mismatches = audit.covered.filter((name) => after.files[name]);
  for (const name of audit.retained) {
    const before = snapshot.files[name],
      next = after.files[name];
    if (
      !next ||
      before.rawSHA256 !== next.rawSHA256 ||
      !equal(before.working, next.working) ||
      !equal(before.index, next.index)
    )
      mismatches.push(name);
  }
  if (after.head !== audit.target || mismatches.length) {
    throw new Error(
      `Post-sync verification failed; retain backup ${backupRef} and receipt ${receiptPath}: ${mismatches.join(", ")}`,
    );
  }
  return {
    synchronized: true,
    target: audit.target,
    covered: audit.covered,
    retained: audit.retained,
    backupRef,
    receipt: receiptPath,
  };
}

try {
  const [command, first, second, third, ...rest] = process.argv.slice(2);
  if (command === "capture" && first && second && third && rest.length === 0) {
    const cwd = fs.realpathSync(
      git(path.resolve(first), ["rev-parse", "--show-toplevel"]).trim(),
    );
    const receiptPath = path.resolve(second),
      scopePath = path.resolve(third);
    if (receiptPath === cwd || receiptPath.startsWith(`${cwd}${path.sep}`))
      throw new Error("Keep recovery receipt outside source worktree");
    const ownedPaths = JSON.parse(fs.readFileSync(scopePath, "utf8"));
    if (
      !Array.isArray(ownedPaths) ||
      ownedPaths.some(
        (name) =>
          typeof name !== "string" ||
          !name ||
          path.isAbsolute(name) ||
          name.split("/").includes(".."),
      )
    )
      throw new Error(
        "Scope must be a JSON array of repository-relative paths",
      );
    const repository = fs.realpathSync(
      path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()),
    );
    const snapshot = state(cwd);
    if (!equal(snapshot, state(cwd)))
      throw new Error("Source changed during capture");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({ version: 1, cwd, repository, ownedPaths, snapshot }),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        captured: true,
        source: cwd,
        head: snapshot.head,
        receipt: receiptPath,
      }),
    );
  } else if (
    ["inspect", "finish"].includes(command) &&
    first &&
    second &&
    rest.length === 0 &&
    (command === "inspect" ? !third : third === "--source-idle")
  ) {
    const receiptPath = path.resolve(first),
      receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (receipt.version !== 1) throw new Error("Unsupported receipt version");
    const audit = inspect(receipt, second);
    console.log(
      JSON.stringify(
        command === "finish"
          ? finish(receipt, audit, receiptPath)
          : {
              source: receipt.cwd,
              target: audit.target,
              sourceHeadChanged: audit.current.head !== receipt.snapshot.head,
              sourceIndexChanged:
                audit.current.index !== receipt.snapshot.index,
              covered: audit.covered,
              retained: audit.retained,
              changed: audit.changed,
              historyUncovered: audit.historyUncovered,
              indexUncovered: audit.indexUncovered,
              canFinish: audit.canFinish,
            },
      ),
    );
  } else
    throw new Error(
      "Usage: source-worktree.mjs capture <source> <receipt.json> <scope.json> | inspect <receipt.json> <target> | finish <receipt.json> <target> --source-idle",
    );
} catch (error) {
  console.error(JSON.stringify({ synchronized: false, error: error.message }));
  process.exitCode = 1;
}
