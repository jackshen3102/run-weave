import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTeamAcceptanceCase } from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";
import {
  AGENT_TEAM_TEST_PLAN_SUFFIX,
  parseAgentTeamTestPlan,
  type AgentTeamTestPlanCase,
} from "./test-plan";

export interface ResolvedAgentTeamProjectFile {
  absolutePath: string;
  relativePath: string;
}

export interface LoadedAgentTeamAcceptanceCases {
  sourceFilePath: string;
  cases: AgentTeamAcceptanceCase[];
}

const AGENT_TEAM_PROJECT_FILE_MISSING = "agent_team_project_file_missing";

export function isAgentTeamProjectFileMissingError(
  error: unknown,
  requestedPath?: string,
): error is AgentTeamError {
  if (!(error instanceof AgentTeamError) || !error.details) {
    return false;
  }
  const details = error.details as {
    code?: unknown;
    requestedPath?: unknown;
  };
  return (
    details.code === AGENT_TEAM_PROJECT_FILE_MISSING &&
    (requestedPath === undefined || details.requestedPath === requestedPath)
  );
}

export async function resolveAgentTeamProjectFile(
  projectRoot: string,
  requestedPath: string,
  label: string,
): Promise<ResolvedAgentTeamProjectFile> {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new AgentTeamError(400, `${label}不能为空`);
  }
  if (trimmedPath.startsWith("~")) {
    throw new AgentTeamError(400, `${label}不支持 home 路径`);
  }

  const rootPath = await realpath(projectRoot).catch(() => null);
  if (!rootPath) {
    throw new AgentTeamError(409, "当前项目目录不可用，无法解析验收来源文件");
  }
  const candidatePath = path.isAbsolute(trimmedPath)
    ? path.resolve(trimmedPath)
    : path.resolve(rootPath, trimmedPath);
  if (!isInsidePath(rootPath, candidatePath)) {
    throw new AgentTeamError(403, `${label}必须位于当前项目目录内`);
  }
  const resolvedPath = await realpath(candidatePath).catch((error: unknown) => {
    if (isMissingFileSystemEntry(error)) {
      return null;
    }
    throw new AgentTeamError(400, `${label}无法访问：${trimmedPath}`);
  });
  if (!resolvedPath) {
    throw new AgentTeamError(400, `${label}不存在：${trimmedPath}`, {
      code: AGENT_TEAM_PROJECT_FILE_MISSING,
      requestedPath: trimmedPath,
      label,
    });
  }
  if (!isInsidePath(rootPath, resolvedPath)) {
    throw new AgentTeamError(403, `${label}必须位于当前项目目录内`);
  }
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new AgentTeamError(400, `${label}不是文件：${trimmedPath}`);
  }
  return {
    absolutePath: resolvedPath,
    relativePath: toPosixRelativePath(rootPath, resolvedPath),
  };
}

export async function loadAcceptanceCasesFromTestPlan(params: {
  projectRoot: string;
  requestedPath: string;
}): Promise<LoadedAgentTeamAcceptanceCases> {
  const resolved = await resolveAgentTeamProjectFile(
    params.projectRoot,
    params.requestedPath,
    "测试案例文件",
  );
  assertAgentTeamTestPlanFilePath(resolved.relativePath);
  const yaml = await readFile(resolved.absolutePath, "utf8");
  const testPlan = parseAgentTeamTestPlan(yaml, resolved.relativePath);
  return {
    sourceFilePath: resolved.relativePath,
    cases: testPlan.cases
      .filter((testCase) => testCase.required)
      .map((testCase) => buildAcceptanceCase(testCase, resolved.relativePath)),
  };
}

export function assertAgentTeamTestPlanFilePath(relativePath: string): void {
  if (
    !relativePath.startsWith("docs/testing/") ||
    !relativePath.endsWith(AGENT_TEAM_TEST_PLAN_SUFFIX)
  ) {
    throw new AgentTeamError(
      400,
      `测试案例文件必须位于 docs/testing/ 且以 ${AGENT_TEAM_TEST_PLAN_SUFFIX} 结尾：${relativePath}`,
    );
  }
}

function buildAcceptanceCase(
  testCase: AgentTeamTestPlanCase,
  sourceFilePath: string,
): AgentTeamAcceptanceCase {
  return {
    caseId: testCase.id,
    sourceCaseId: testCase.id,
    sourceFilePath,
    sourceHeading: `${testCase.id} ${testCase.name}`,
    tags: ["required"],
    dependsOn: [],
    text: [
      `标题：${testCase.name}`,
      `描述：${testCase.description}`,
      "前提条件：",
      ...testCase.preconditions.map((item, index) => `${index + 1}. ${item}`),
      "执行步骤：",
      ...testCase.steps.map((item, index) => `${index + 1}. ${item}`),
    ].join("\n"),
    status: "pending",
    consecutiveFail: 0,
    resultSummary: null,
    evidence: [],
    bouncedToPanelId: null,
    recheckRequestedAt: null,
    recheckDispatchId: null,
    recheckWorkerPanelId: null,
    recheckWorkerRole: null,
    recheckOutboxMtimeMs: null,
    recheckAttempt: 0,
    lastRunStatus: "pending",
    skipReason: null,
  };
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
