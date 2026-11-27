import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const BUDGET_RELATIVE_PATH = "scripts/quality/context-budget.json";
const BUDGET_FILE_PATH = path.join(REPO_ROOT, BUDGET_RELATIVE_PATH);

const METRIC_KEYS = [
  "rootAgentsMdBytes",
  "maxScopedAgentsMdBytes",
  "toolkitSkillFrontmatterTotalBytes",
  "maxSingleSkillDescriptionBytes",
  "runweaveMcpInstructionsBytes",
  "runweaveMcpToolsJsonBytes",
];

function normalizeLf(text) {
  return text.replace(/\r\n/g, "\n");
}

function utf8Bytes(text) {
  return Buffer.byteLength(normalizeLf(text), "utf8");
}

function readNormalizedFile(relativePath) {
  return normalizeLf(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  );
}

function listScopedAgentsMdFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "**/AGENTS.md", "AGENTS.md"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (filePath) =>
        Boolean(filePath) &&
        filePath !== "AGENTS.md" &&
        !filePath.startsWith("plugins/toolkit/skills/") &&
        existsSync(path.join(REPO_ROOT, filePath)),
    )
    .sort();
}

function extractSkillFrontmatter(content) {
  const normalized = normalizeLf(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { frontmatter: "", description: "" };
  }
  const frontmatter = match[1];
  const lines = frontmatter.split("\n");
  let description = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (!descMatch) {
      continue;
    }
    const inlineValue = descMatch[1].trim();
    if (
      inlineValue &&
      inlineValue !== "|" &&
      inlineValue !== ">" &&
      inlineValue !== "|-" &&
      inlineValue !== ">-"
    ) {
      description = inlineValue.replace(/^["']|["']$/g, "");
    } else {
      const blockLines = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^\s+/.test(lines[next])) {
          blockLines.push(lines[next].trim());
        } else {
          break;
        }
      }
      description = blockLines.join(" ");
    }
    break;
  }
  return { frontmatter, description };
}

function inspectSkillsFrontmatter() {
  const skillsRoot = path.join(REPO_ROOT, "plugins/toolkit/skills");
  if (!existsSync(skillsRoot)) {
    return [];
  }
  const entries = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const items = [];
  for (const skill of entries) {
    const relativePath = path.join("plugins/toolkit/skills", skill, "SKILL.md");
    if (!existsSync(path.join(REPO_ROOT, relativePath))) {
      continue;
    }
    const content = readNormalizedFile(relativePath);
    const { frontmatter, description } = extractSkillFrontmatter(content);
    items.push({
      skill,
      bytes: utf8Bytes(frontmatter),
      descriptionBytes: utf8Bytes(description),
    });
  }
  return items;
}

function inspectRunweaveMcpSurface() {
  const inlineScript = [
    'import { inspectMcpSurfaceForBudget } from "../packages/runweave-mcp/src/tools.ts";',
    "inspectMcpSurfaceForBudget().then((res) => process.stdout.write(JSON.stringify(res)));",
  ].join(" ");
  const result = spawnSync(
    "pnpm",
    ["--dir", "backend", "exec", "tsx", "-e", inlineScript],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to inspect runweave-mcp surface: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  return JSON.parse(result.stdout);
}

function readBudgetFile() {
  if (!existsSync(BUDGET_FILE_PATH)) {
    return null;
  }
  return JSON.parse(readNormalizedFile(BUDGET_RELATIVE_PATH));
}

function readBudgetFromGitRef(gitRef) {
  if (!gitRef) {
    return null;
  }
  const result = spawnSync(
    "git",
    ["show", `${gitRef}:${BUDGET_RELATIVE_PATH}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status === 0 && result.stdout) {
    return JSON.parse(normalizeLf(result.stdout));
  }
  return null;
}

function parseCliArgs(argv) {
  const options = {
    json: false,
    update: false,
    compareGitRef: null,
    allowIncrease: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--update") {
      options.update = true;
    } else if (arg === "--allow-increase") {
      options.allowIncrease = true;
    } else if (arg === "--compare-git-ref") {
      options.compareGitRef = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--compare-git-ref=")) {
      options.compareGitRef = arg.slice("--compare-git-ref=".length);
    } else {
      throw new Error(`Unknown context-budget argument: ${arg}`);
    }
  }
  return options;
}

export function evaluateContextBudget(options = {}) {
  const rootAgentsMdBytes = utf8Bytes(readNormalizedFile("AGENTS.md"));
  const scopedAgentsList = listScopedAgentsMdFiles().map((filePath) => ({
    path: filePath,
    bytes: utf8Bytes(readNormalizedFile(filePath)),
  }));
  const maxScopedAgentsMdBytes = scopedAgentsList.reduce(
    (max, item) => Math.max(max, item.bytes),
    0,
  );

  const skillsList = inspectSkillsFrontmatter();
  const toolkitSkillFrontmatterTotalBytes = skillsList.reduce(
    (sum, item) => sum + item.bytes,
    0,
  );
  const maxSingleSkillDescriptionBytes = skillsList.reduce(
    (max, item) => Math.max(max, item.descriptionBytes),
    0,
  );

  const mcpSurface = inspectRunweaveMcpSurface();
  const actuals = {
    rootAgentsMdBytes,
    maxScopedAgentsMdBytes,
    toolkitSkillFrontmatterTotalBytes,
    maxSingleSkillDescriptionBytes,
    runweaveMcpInstructionsBytes: mcpSurface.instructionsBytes,
    runweaveMcpToolsJsonBytes: mcpSurface.toolsJsonBytes,
  };

  if (options.update) {
    const nextBudget = {
      schemaVersion: 1,
      ceilings: actuals,
    };
    writeFileSync(
      BUDGET_FILE_PATH,
      `${JSON.stringify(nextBudget, null, 2)}\n`,
      "utf8",
    );
  }

  const budget = readBudgetFile();
  if (!budget || budget.schemaVersion !== 1 || !budget.ceilings) {
    throw new Error(
      `Missing or invalid ${BUDGET_RELATIVE_PATH}; run "pnpm context:budget --update" to initialize.`,
    );
  }

  const metrics = {};
  let anyExceeded = false;
  for (const key of METRIC_KEYS) {
    const actual = actuals[key];
    const ceiling = Number(budget.ceilings[key]);
    const delta = actual - ceiling;
    const exceeded = actual > ceiling;
    if (exceeded) {
      anyExceeded = true;
    }
    metrics[key] = {
      actual,
      ceiling,
      delta,
      exceeded,
    };
  }

  const ceilingIncreasesAgainstBaseRef = [];
  if (options.compareGitRef) {
    const baseBudget = readBudgetFromGitRef(options.compareGitRef) ?? {
      ceilings: actuals,
    };
    if (baseBudget?.ceilings) {
      for (const key of METRIC_KEYS) {
        const baseCeiling = Number(baseBudget.ceilings[key]);
        const nextCeiling = Number(budget.ceilings[key]);
        if (
          Number.isFinite(baseCeiling) &&
          Number.isFinite(nextCeiling) &&
          nextCeiling > baseCeiling
        ) {
          ceilingIncreasesAgainstBaseRef.push({
            metric: key,
            baseCeiling,
            nextCeiling,
          });
        }
      }
    }
  }

  const topContributors = {
    scopedAgentsMd: [...scopedAgentsList]
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
      .slice(0, 5),
    skillsFrontmatter: [...skillsList]
      .sort(
        (a, b) =>
          b.descriptionBytes - a.descriptionBytes ||
          b.bytes - a.bytes ||
          a.skill.localeCompare(b.skill),
      )
      .slice(0, 5),
    mcpTools: [...mcpSurface.tools]
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
      .slice(0, 5),
  };

  const hasUnapprovedCeilingIncrease =
    ceilingIncreasesAgainstBaseRef.length > 0 && !options.allowIncrease;

  return {
    schemaVersion: 1,
    ok: !anyExceeded && !hasUnapprovedCeilingIncrease,
    metrics,
    topContributors,
    ceilingIncreasesAgainstBaseRef,
  };
}

function formatHumanReport(report) {
  const lines = [];
  for (const [name, item] of Object.entries(report.metrics)) {
    const status = item.exceeded ? "EXCEEDED" : "OK";
    const deltaText =
      item.delta > 0
        ? `+${item.delta} bytes`
        : `${item.delta} bytes (${Math.abs(item.delta)} bytes remaining)`;
    lines.push(
      `context-budget: [${status}] ${name}: actual=${item.actual} ceiling=${item.ceiling} (${deltaText})`,
    );
  }

  const exceededMetrics = Object.entries(report.metrics).filter(
    ([, item]) => item.exceeded,
  );
  if (exceededMetrics.length > 0) {
    lines.push("context-budget: Top 5 contributors:");
    lines.push(
      `  scoped AGENTS.md: ${report.topContributors.scopedAgentsMd
        .map((item) => `${item.path} (${item.bytes} B)`)
        .join(", ")}`,
    );
    lines.push(
      `  skill descriptions: ${report.topContributors.skillsFrontmatter
        .map(
          (item) =>
            `${item.skill} (desc=${item.descriptionBytes} B, fm=${item.bytes} B)`,
        )
        .join(", ")}`,
    );
    lines.push(
      `  mcp tools: ${report.topContributors.mcpTools
        .map((item) => `${item.name} (${item.bytes} B)`)
        .join(", ")}`,
    );
  }

  if (report.ceilingIncreasesAgainstBaseRef.length > 0) {
    for (const increase of report.ceilingIncreasesAgainstBaseRef) {
      lines.push(
        `context-budget: ceiling increase detected against base ref: ${increase.metric} ${increase.baseCeiling} -> ${increase.nextCeiling} (+${increase.nextCeiling - increase.baseCeiling} bytes)`,
      );
    }
  }

  lines.push(
    report.ok
      ? "context-budget: pass"
      : "context-budget: fail (shrink prompt/schema or require explicit context-budget-increase approval)",
  );
  return `${lines.join("\n")}\n`;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const options = parseCliArgs(process.argv.slice(2));
  const report = evaluateContextBudget(options);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatHumanReport(report),
  );
  if (!report.ok) {
    process.exitCode = 1;
  }
}
