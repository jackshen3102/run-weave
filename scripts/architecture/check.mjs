import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImports } from "./import-graph.mjs";
import {
  buildCurrentDebt,
  emptyBaseline,
  readBaseBaseline,
  readWorkingBaseline,
  resolveDefaultBaseRef,
  validateLegacyBaseline,
} from "./legacy-baseline.mjs";
import { analyzeReactMetrics } from "./react-metrics.mjs";
import {
  countPhysicalLines,
  listArchitectureSourceFiles,
  moduleForFile,
  readSourceFile,
  REPO_ROOT,
} from "./scope.mjs";

export async function buildArchitectureReport(options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const sourceFiles = await listArchitectureSourceFiles(root);
  const fileSize = await analyzeFileSizes(root, sourceFiles);
  const imports = await analyzeImports(root, sourceFiles);
  const react = await analyzeReactMetrics(root, sourceFiles);
  const currentDebt = buildCurrentDebt(fileSize, imports);
  const isRepositoryRoot = root === REPO_ROOT;
  const workingBaseline = isRepositoryRoot
    ? await readWorkingBaseline(root)
    : emptyBaseline();
  const baseRef = isRepositoryRoot
    ? (options.baseRef ?? resolveDefaultBaseRef(root))
    : null;
  const baseBaseline = isRepositoryRoot
    ? readBaseBaseline(root, baseRef)
    : null;
  const errors = validateLegacyBaseline(
    currentDebt,
    workingBaseline,
    baseBaseline,
  );

  for (const edge of imports.commonRootImports) {
    errors.push(`Root @runweave/common import is forbidden: ${edge}`);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    baseRef,
    summary: {
      sourceFiles: sourceFiles.length,
      physicalLines: fileSize.totalLines,
      filesOver600: fileSize.violations.length,
      filesFrom500To600: fileSize.nearLimit.length,
      runtimeCycles: imports.runtimeCycles.length,
      typeOnlyCycles: imports.typeOnlyCycles.length,
      forbiddenImports: imports.forbiddenImports.length,
      sharedRootImports: imports.sharedRootImports.length,
      propsAtLeast10: react.propsAtLeast10.length,
      componentCallsAtLeast10: react.componentCallsAtLeast10.length,
      functionsAtLeast200: react.functionsAtLeast200.length,
      errors: errors.length,
    },
    fileSize,
    imports: {
      parsedFileCount: imports.parsedFileCount,
      edgeCount: imports.edgeCount,
      runtimeCycles: imports.runtimeCycles,
      typeOnlyCycles: imports.typeOnlyCycles,
      forbiddenImports: imports.forbiddenImports,
      sharedRootImports: imports.sharedRootImports,
      commonRootImports: imports.commonRootImports,
    },
    react,
    currentDebt,
    errors,
  };
}

export async function analyzeFileSizes(root, sourceFiles) {
  const files = [];
  const modules = new Map();
  for (const file of sourceFiles) {
    const lines = countPhysicalLines(await readSourceFile(root, file));
    const module = moduleForFile(file);
    files.push({ file, lines, module });
    const current = modules.get(module) ?? {
      files: 0,
      physicalLines: 0,
      filesOver600: 0,
      filesFrom500To600: 0,
    };
    current.files += 1;
    current.physicalLines += lines;
    if (lines > 600) {
      current.filesOver600 += 1;
    } else if (lines >= 500) {
      current.filesFrom500To600 += 1;
    }
    modules.set(module, current);
  }
  return {
    totalLines: files.reduce((sum, item) => sum + item.lines, 0),
    modules: Object.fromEntries(
      [...modules].sort(([left], [right]) => left.localeCompare(right)),
    ),
    violations: files
      .filter((item) => item.lines > 600)
      .sort(
        (left, right) =>
          right.lines - left.lines || left.file.localeCompare(right.file),
      ),
    nearLimit: files
      .filter((item) => item.lines >= 500 && item.lines <= 600)
      .sort(
        (left, right) =>
          right.lines - left.lines || left.file.localeCompare(right.file),
      ),
    files,
  };
}

function parseArgs(argv) {
  const options = {
    mode: "check",
    root: REPO_ROOT,
    output: null,
    baseRef: undefined,
    printBaseline: false,
    json: false,
  };
  for (const argument of argv) {
    if (argument === "--report") {
      options.mode = "report";
    } else if (argument === "--print-baseline") {
      options.mode = "report";
      options.printBaseline = true;
      options.json = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument.startsWith("--root=")) {
      options.root = argument.slice("--root=".length);
    } else if (argument.startsWith("--output=")) {
      options.output = argument.slice("--output=".length);
    } else if (argument.startsWith("--base-ref=")) {
      options.baseRef = argument.slice("--base-ref=".length);
    } else {
      throw new Error(`Unknown architecture check argument: ${argument}`);
    }
  }
  return options;
}

function baselineOutput(report) {
  return {
    schemaVersion: 1,
    generatedFrom: {
      commit: readGitHead(report.root),
      generatedAt: report.generatedAt,
    },
    ...report.currentDebt,
  };
}

function readGitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildArchitectureReport(options);
  const printable = options.printBaseline ? baselineOutput(report) : report;
  const json = `${JSON.stringify(printable, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(options.root, options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json);
  }
  process.stdout.write(options.json ? json : formatSummary(report));
  if (options.mode === "check" && report.errors.length > 0) {
    process.exitCode = 1;
  }
}

function formatSummary(report) {
  const summary = report.summary;
  const lines = [
    `architecture: files=${summary.sourceFiles} lines=${summary.physicalLines} over600=${summary.filesOver600} nearLimit=${summary.filesFrom500To600}`,
    `architecture: runtimeCycles=${summary.runtimeCycles} typeOnlyCycles=${summary.typeOnlyCycles} forbiddenImports=${summary.forbiddenImports} sharedRootImports=${summary.sharedRootImports}`,
    `architecture: props>=10=${summary.propsAtLeast10} componentCalls>=10=${summary.componentCallsAtLeast10} functions>=200=${summary.functionsAtLeast200}`,
  ];
  if (report.errors.length === 0) {
    lines.push(
      "architecture: pass (legacy debt matches the ratcheted baseline)",
    );
  } else {
    lines.push(
      ...report.errors.map((error) => `architecture: error: ${error}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  await main();
}
