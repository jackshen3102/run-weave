import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArchitectureReport } from "./architecture/check.mjs";
import {
  emptyBaseline,
  validateLegacyBaseline,
} from "./architecture/legacy-baseline.mjs";
import { countPhysicalLines } from "./architecture/scope.mjs";

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "runweave-architecture-"),
);

try {
  verifyPhysicalLineCounting();
  await verifyFileSizeBoundaries();
  await verifyImportBoundaries();
  verifyBaselineRatchet();
  console.log("architecture verification passed");
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}

function verifyPhysicalLineCounting() {
  assert.equal(countPhysicalLines(""), 0);
  assert.equal(countPhysicalLines("one"), 1);
  assert.equal(countPhysicalLines("one\n"), 1);
  assert.equal(countPhysicalLines("one\ntwo"), 2);
  assert.equal(countPhysicalLines("one\r\ntwo\r\n"), 2);
  assert.equal(countPhysicalLines("\n\n"), 2);
}

async function verifyFileSizeBoundaries() {
  const passingRoot = path.join(tempRoot, "passing");
  const failingRoot = path.join(tempRoot, "failing");
  const extensions = ["ts", "tsx", "css", "mjs", "cjs", "sh"];
  await mkdir(passingRoot, { recursive: true });
  await mkdir(failingRoot, { recursive: true });

  for (const extension of extensions) {
    await writeFile(
      path.join(passingRoot, `lines-599.${extension}`),
      buildLines(599, extension),
    );
    await writeFile(
      path.join(passingRoot, `lines-600.${extension}`),
      buildLines(600, extension),
    );
    await writeFile(
      path.join(failingRoot, `lines-601.${extension}`),
      buildLines(601, extension),
    );
  }

  const passing = await buildArchitectureReport({ root: passingRoot });
  const failing = await buildArchitectureReport({ root: failingRoot });
  assert.equal(passing.summary.filesOver600, 0);
  assert.deepEqual(passing.errors, []);
  assert.equal(failing.summary.filesOver600, extensions.length);
  assert.equal(
    failing.errors.filter((error) => error.includes("New >600 line file"))
      .length,
    extensions.length,
  );
}

async function verifyImportBoundaries() {
  const root = path.join(tempRoot, "imports");
  await writeFixture(root, "app/src/services/http.ts", [
    'import { record } from "../components/LogPanel";',
    "export const request = record;",
  ]);
  await writeFixture(root, "app/src/components/LogPanel.tsx", [
    'import { request } from "../services/http";',
    "export const record = request;",
  ]);
  await writeFixture(root, "backend/src/terminal/manager.ts", [
    'import type { TerminalState } from "./terminal-state";',
    "export type ManagerState = TerminalState;",
  ]);
  await writeFixture(root, "backend/src/terminal/terminal-state.ts", [
    'import type { ManagerState } from "./manager";',
    "export type TerminalState = ManagerState;",
  ]);

  const report = await buildArchitectureReport({ root });
  assert.equal(report.summary.runtimeCycles, 1);
  assert.equal(report.summary.typeOnlyCycles, 1);
  assert.equal(report.summary.forbiddenImports, 1);
  assert.ok(report.errors.some((error) => error.includes("New runtime cycle")));
  assert.ok(
    report.errors.some((error) => error.includes("New type-only cycle")),
  );
  assert.ok(
    report.errors.some((error) => error.includes("New forbidden import")),
  );
}

function verifyBaselineRatchet() {
  const base = {
    ...emptyBaseline(),
    fileSize: { "legacy.ts": 700 },
    runtimeCycles: [["a.ts", "b.ts"]],
    forbiddenImports: ["a.ts -> b.ts"],
  };
  const reduced = {
    ...emptyBaseline(),
    fileSize: { "legacy.ts": 650 },
  };
  const reducedDebt = {
    fileSize: { "legacy.ts": 650 },
    runtimeCycles: [],
    typeOnlyCycles: [],
    forbiddenImports: [],
    sharedRootImports: [],
  };
  assert.deepEqual(validateLegacyBaseline(reducedDebt, reduced, base), []);

  const grown = {
    ...reduced,
    fileSize: { "legacy.ts": 701 },
  };
  const grownDebt = {
    ...reducedDebt,
    fileSize: { "legacy.ts": 701 },
  };
  assert.ok(
    validateLegacyBaseline(grownDebt, grown, base).some((error) =>
      error.includes("cannot grow"),
    ),
  );

  const added = {
    ...reduced,
    fileSize: { "legacy.ts": 650, "new.ts": 650 },
  };
  const addedDebt = {
    ...reducedDebt,
    fileSize: { "legacy.ts": 650, "new.ts": 650 },
  };
  assert.ok(
    validateLegacyBaseline(addedDebt, added, base).some((error) =>
      error.includes("cannot add"),
    ),
  );
}

function buildLines(count, extension) {
  const line =
    extension === "css"
      ? "/* line */"
      : extension === "sh"
        ? "# line"
        : "// line";
  return `${Array.from({ length: count }, () => line).join("\n")}\n`;
}

async function writeFixture(root, relativePath, lines) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join("\n")}\n`);
}
