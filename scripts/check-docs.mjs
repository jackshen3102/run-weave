import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const REQUIRED_ENTRYPOINTS = [
  "AGENTS.md",
  "docs/README.md",
  "docs/architecture/README.md",
  "docs/cli/README.md",
  "docs/deployment/README.md",
  "docs/quality/README.md",
  "docs/testing/README.md",
  "frontend/AGENTS.md",
  "backend/AGENTS.md",
  "electron/AGENTS.md",
  "app/AGENTS.md",
  "app-server/AGENTS.md",
  "packages/common/AGENTS.md",
  "packages/shared/AGENTS.md",
  "packages/runweave-cli/AGENTS.md",
  "packages/terminal-renderer/AGENTS.md",
  "scripts/dev-session/AGENTS.md",
];

function listDocumentationFiles() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter(isDocumentationFile)
    .sort();
}

function isDocumentationFile(filePath) {
  return (
    filePath === "AGENTS.md" ||
    filePath === "README.md" ||
    filePath === "README.zh-CN.md" ||
    filePath.startsWith("docs/") ||
    filePath.startsWith(".agents/rules/") ||
    filePath.endsWith("/AGENTS.md")
  );
}

function stripFencedCode(content) {
  return content.replace(
    /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm,
    "",
  );
}

function extractLinkTarget(rawDestination) {
  const destination = rawDestination.trim();
  if (destination.startsWith("<")) {
    const closingBracket = destination.indexOf(">");
    return closingBracket === -1
      ? destination
      : destination.slice(1, closingBracket);
  }
  return destination.split(/\s+/)[0] ?? "";
}

function isLocalRelativeLink(target) {
  return (
    target.length > 0 &&
    !target.startsWith("#") &&
    !target.startsWith("/") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

function resolveLink(filePath, target) {
  const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  if (!withoutFragment) {
    return null;
  }
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return { error: `invalid URL encoding in "${target}"` };
  }
  return {
    absolutePath: path.resolve(REPO_ROOT, path.dirname(filePath), decoded),
  };
}

async function findBrokenLinks(filePath) {
  const content = stripFencedCode(
    await readFile(path.join(REPO_ROOT, filePath), "utf8"),
  );
  const failures = [];
  for (const match of content.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    const target = extractLinkTarget(match[1]);
    if (!isLocalRelativeLink(target)) {
      continue;
    }
    const resolved = resolveLink(filePath, target);
    if (!resolved) {
      continue;
    }
    if (resolved.error) {
      failures.push(`${filePath}: ${resolved.error}`);
      continue;
    }
    if (!existsSync(resolved.absolutePath)) {
      failures.push(`${filePath}: missing link target "${target}"`);
    }
  }
  return failures;
}

async function main() {
  const failures = [];

  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    if (!existsSync(path.join(REPO_ROOT, entrypoint))) {
      failures.push(`missing required documentation entrypoint: ${entrypoint}`);
    }
  }

  const files = listDocumentationFiles();
  for (const filePath of files) {
    failures.push(...(await findBrokenLinks(filePath)));
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`docs: error: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `docs: pass (${files.length} Markdown files, ${REQUIRED_ENTRYPOINTS.length} required entrypoints)`,
  );
}

await main();
