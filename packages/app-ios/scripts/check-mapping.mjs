import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkg, "../..");
const map = JSON.parse(
  readFileSync(resolve(pkg, "docs/legacy-map.json"), "utf8"),
);
const cases = new Set();
for (const file of readdirSync(resolve(repo, "docs/testing/app"))) {
  if (!file.endsWith(".testplan.yaml")) continue;
  const text = readFileSync(resolve(repo, "docs/testing/app", file), "utf8");
  for (const match of text.matchAll(/^\s+- id: ([A-Z]+-\d{3})\s*$/gm))
    cases.add(match[1]);
}
const errors = [];
const ids = new Set();
function pathExists(path) {
  if (
    typeof path !== "string" ||
    isAbsolute(path) ||
    relative(repo, resolve(repo, path)).startsWith("..")
  )
    return false;
  return existsSync(resolve(repo, path));
}
if (map.version !== 1 || !Array.isArray(map.mappings) || !map.mappings.length) {
  throw new Error("Invalid mapping document");
}
for (const row of map.mappings) {
  const fail = (message) => errors.push(`${row.id}: ${message}`);
  if (!/^MAP-\d{2}$/.test(row.id) || ids.has(row.id))
    fail("invalid or duplicate ID");
  ids.add(row.id);
  if (!row.feature || !/^[a-f0-9]{40}$/.test(row.baselineCommit))
    fail("missing feature or baseline commit");
  if (!["planned", "implemented", "verified", "deferred"].includes(row.status))
    fail("invalid status");
  for (const key of [
    "legacyPaths",
    "nativePaths",
    "contractPaths",
    "api",
    "caseIds",
  ]) {
    if (!Array.isArray(row[key]))
      throw new Error(`${row.id}: ${key} must be an array`);
  }
  if (!row.legacyPaths.length || !row.nativePaths.length || !row.caseIds.length)
    fail("missing mapped paths or cases");
  for (const path of new Set([...row.legacyPaths, ...row.contractPaths])) {
    if (!pathExists(path)) {
      fail(`missing source ${path}`);
      continue;
    }
    const hash = createHash("sha256")
      .update(readFileSync(resolve(repo, path)))
      .digest("hex");
    if (row.sourceHashes?.[path] !== hash)
      fail(`STALE source ${path}; review changes before updating baseline`);
  }
  for (const id of row.caseIds) if (!cases.has(id)) fail(`unknown case ${id}`);
  if (["implemented", "verified"].includes(row.status)) {
    for (const path of row.nativePaths)
      if (!pathExists(path)) fail(`missing native path ${path}`);
  }
  if (row.status === "verified") {
    if (!pathExists(row.evidencePath))
      fail("verified requires an existing evidence file");
    else {
      const evidence = JSON.parse(
        readFileSync(resolve(repo, row.evidencePath), "utf8"),
      );
      for (const id of row.caseIds) {
        if (
          evidence.cases?.[id]?.verdict !== "pass" ||
          !evidence.cases[id].evidence?.length
        ) {
          fail(`verified requires PASS and evidence references for ${id}`);
        }
      }
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `${ids.size} mappings valid; source hashes current. File checks do not establish runtime acceptance.`,
  );
