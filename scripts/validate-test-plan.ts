import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAcceptanceCasesFromTestPlan } from "../backend/src/agent-team/acceptance-case-loader";
import { AGENT_TEAM_TEST_PLAN_SUFFIX } from "../backend/src/agent-team/test-plan";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
void main();

async function main(): Promise<void> {
  const requestedPaths = process.argv.slice(2);
  const testPlanPaths =
    requestedPaths.length > 0
      ? requestedPaths
      : await collectTestPlanPaths(path.join(repoRoot, "docs/testing"));

  if (testPlanPaths.length === 0) {
    throw new Error("docs/testing 下没有可校验的 *.testplan.yaml 文件");
  }

  for (const requestedPath of testPlanPaths) {
    const loaded = await loadAcceptanceCasesFromTestPlan({
      projectRoot: repoRoot,
      requestedPath,
    });
    console.log(
      `validated ${loaded.sourceFilePath}: ${loaded.cases.length} required case(s)`,
    );
  }
}

async function collectTestPlanPaths(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectTestPlanPaths(entryPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(AGENT_TEAM_TEST_PLAN_SUFFIX)
    ) {
      paths.push(path.relative(repoRoot, entryPath).split(path.sep).join("/"));
    }
  }
  return paths.sort();
}
