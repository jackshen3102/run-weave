import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cycleSignature } from "./import-graph.mjs";

export const BASELINE_RELATIVE_PATH =
  "scripts/architecture/legacy-baseline.json";

export async function readWorkingBaseline(root) {
  try {
    return parseBaseline(
      await readFile(path.join(root, BASELINE_RELATIVE_PATH), "utf8"),
      BASELINE_RELATIVE_PATH,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyBaseline();
    }
    throw error;
  }
}

export function readBaseBaseline(root, baseRef) {
  if (!baseRef) {
    return null;
  }
  try {
    const raw = execFileSync(
      "git",
      ["show", `${baseRef}:${BASELINE_RELATIVE_PATH}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseBaseline(raw, `${baseRef}:${BASELINE_RELATIVE_PATH}`);
  } catch {
    return null;
  }
}

export function resolveDefaultBaseRef(root) {
  const configured = process.env.ARCHITECTURE_BASE_REF?.trim();
  if (configured) {
    return configured;
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
      cwd: root,
      stdio: "ignore",
    });
    return "origin/main";
  } catch {
    return null;
  }
}

export function buildCurrentDebt(fileSize, imports) {
  return {
    fileSize: Object.fromEntries(
      fileSize.violations.map((item) => [item.file, item.lines]),
    ),
    runtimeCycles: imports.runtimeCycles,
    typeOnlyCycles: imports.typeOnlyCycles,
    forbiddenImports: imports.forbiddenImports,
    sharedRootImports: imports.sharedRootImports,
  };
}

export function validateLegacyBaseline(currentDebt, working, base) {
  const errors = [];
  compareExactFileSizes(currentDebt.fileSize, working.fileSize, errors);
  compareExactSet(
    "runtime cycle",
    currentDebt.runtimeCycles.map(cycleSignature),
    working.runtimeCycles.map(cycleSignature),
    errors,
  );
  compareExactSet(
    "type-only cycle",
    currentDebt.typeOnlyCycles.map(cycleSignature),
    working.typeOnlyCycles.map(cycleSignature),
    errors,
  );
  compareExactSet(
    "forbidden import",
    currentDebt.forbiddenImports,
    working.forbiddenImports,
    errors,
  );
  compareExactSet(
    "shared root import",
    currentDebt.sharedRootImports,
    working.sharedRootImports,
    errors,
  );
  if (base) {
    validateRatchet(working, base, errors);
  }
  return errors;
}

export function emptyBaseline() {
  return {
    schemaVersion: 1,
    generatedFrom: null,
    fileSize: {},
    runtimeCycles: [],
    typeOnlyCycles: [],
    forbiddenImports: [],
    sharedRootImports: [],
  };
}

function parseBaseline(raw, source) {
  const parsed = JSON.parse(raw);
  if (parsed?.schemaVersion !== 1) {
    throw new Error(`Unsupported architecture baseline schema: ${source}`);
  }
  return {
    ...emptyBaseline(),
    ...parsed,
    fileSize: parsed.fileSize ?? {},
    runtimeCycles: parsed.runtimeCycles ?? [],
    typeOnlyCycles: parsed.typeOnlyCycles ?? [],
    forbiddenImports: parsed.forbiddenImports ?? [],
    sharedRootImports: parsed.sharedRootImports ?? [],
  };
}

function compareExactFileSizes(current, baseline, errors) {
  for (const [file, lines] of Object.entries(current)) {
    if (baseline[file] == null) {
      errors.push(
        `New >600 line file is not in the legacy baseline: ${file} (${lines})`,
      );
      continue;
    }
    if (baseline[file] !== lines) {
      errors.push(
        `Legacy file-size baseline must equal the current physical line count: ${file} baseline=${baseline[file]} current=${lines}`,
      );
    }
  }
  for (const file of Object.keys(baseline)) {
    if (current[file] == null) {
      errors.push(`Remove resolved file-size debt from the baseline: ${file}`);
    }
  }
}

function compareExactSet(label, currentValues, baselineValues, errors) {
  const current = new Set(currentValues);
  const baseline = new Set(baselineValues);
  for (const value of current) {
    if (!baseline.has(value)) {
      errors.push(`New ${label} is not in the legacy baseline: ${value}`);
    }
  }
  for (const value of baseline) {
    if (!current.has(value)) {
      errors.push(`Remove resolved ${label} from the baseline: ${value}`);
    }
  }
}

function validateRatchet(current, base, errors) {
  for (const [file, lines] of Object.entries(current.fileSize)) {
    if (base.fileSize[file] == null) {
      errors.push(`Legacy baseline cannot add a file-size exception: ${file}`);
    } else if (lines > base.fileSize[file]) {
      errors.push(
        `Legacy file-size debt cannot grow: ${file} base=${base.fileSize[file]} current=${lines}`,
      );
    }
  }
  validateSetRatchet(
    "runtime cycle",
    current.runtimeCycles,
    base.runtimeCycles,
    errors,
    cycleSignature,
  );
  validateSetRatchet(
    "type-only cycle",
    current.typeOnlyCycles,
    base.typeOnlyCycles,
    errors,
    cycleSignature,
  );
  validateSetRatchet(
    "forbidden import",
    current.forbiddenImports,
    base.forbiddenImports,
    errors,
  );
  validateSetRatchet(
    "shared root import",
    current.sharedRootImports,
    base.sharedRootImports,
    errors,
  );
}

function validateSetRatchet(
  label,
  currentValues,
  baseValues,
  errors,
  normalize = (value) => value,
) {
  const base = new Set(baseValues.map(normalize));
  for (const value of currentValues) {
    const normalized = normalize(value);
    if (!base.has(normalized)) {
      errors.push(`Legacy baseline cannot add ${label}: ${normalized}`);
    }
  }
}
