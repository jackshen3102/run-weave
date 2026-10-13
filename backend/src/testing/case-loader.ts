import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TestPlanError } from "./errors";
import {
  TEST_PLAN_SUFFIX,
  parseTestPlan,
  type TestPlanCase,
} from "./test-plan";

export interface ResolvedTestPlanProjectFile {
  absolutePath: string;
  relativePath: string;
}

export interface LoadedTestPlanAcceptanceCases {
  sourceFilePath: string;
  cases: TestPlanCase[];
}

const TEST_PLAN_PROJECT_FILE_MISSING = "test_plan_project_file_missing";

export async function resolveTestPlanProjectFile(
  projectRoot: string,
  requestedPath: string,
  label: string,
): Promise<ResolvedTestPlanProjectFile> {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new TestPlanError(400, `${label}不能为空`);
  }
  if (trimmedPath.startsWith("~")) {
    throw new TestPlanError(400, `${label}不支持 home 路径`);
  }

  const rootPath = await realpath(projectRoot).catch(() => null);
  if (!rootPath) {
    throw new TestPlanError(409, "当前项目目录不可用，无法解析验收来源文件");
  }
  const candidatePath = path.isAbsolute(trimmedPath)
    ? path.resolve(trimmedPath)
    : path.resolve(rootPath, trimmedPath);
  if (!isInsidePath(rootPath, candidatePath)) {
    throw new TestPlanError(403, `${label}必须位于当前项目目录内`);
  }
  const resolvedPath = await realpath(candidatePath).catch((error: unknown) => {
    if (isMissingFileSystemEntry(error)) {
      return null;
    }
    throw new TestPlanError(400, `${label}无法访问：${trimmedPath}`);
  });
  if (!resolvedPath) {
    throw new TestPlanError(400, `${label}不存在：${trimmedPath}`, {
      code: TEST_PLAN_PROJECT_FILE_MISSING,
      requestedPath: trimmedPath,
      label,
    });
  }
  if (!isInsidePath(rootPath, resolvedPath)) {
    throw new TestPlanError(403, `${label}必须位于当前项目目录内`);
  }
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new TestPlanError(400, `${label}不是文件：${trimmedPath}`);
  }
  return {
    absolutePath: resolvedPath,
    relativePath: toPosixRelativePath(rootPath, resolvedPath),
  };
}

export async function loadAcceptanceCasesFromTestPlan(params: {
  projectRoot: string;
  requestedPath: string;
}): Promise<LoadedTestPlanAcceptanceCases> {
  const resolved = await resolveTestPlanProjectFile(
    params.projectRoot,
    params.requestedPath,
    "测试案例文件",
  );
  assertTestPlanFilePath(resolved.relativePath);
  const yaml = await readFile(resolved.absolutePath, "utf8");
  const testPlan = parseTestPlan(yaml, resolved.relativePath);
  return {
    sourceFilePath: resolved.relativePath,
    cases: testPlan.cases.filter((testCase) => testCase.required),
  };
}

export function assertTestPlanFilePath(relativePath: string): void {
  if (
    !relativePath.startsWith("docs/testing/") ||
    !relativePath.endsWith(TEST_PLAN_SUFFIX)
  ) {
    throw new TestPlanError(
      400,
      `测试案例文件必须位于 docs/testing/ 且以 ${TEST_PLAN_SUFFIX} 结尾：${relativePath}`,
    );
  }
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isMissingFileSystemEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}
