import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTeamAcceptanceCase } from "@runweave/shared";
import { AgentTeamError } from "./errors";

const CASE_HEADING_PATTERN = /^###\s+([A-Z][A-Z0-9-]*-\d{3})\b\s*(.*)$/;
const CASE_ID_PATTERN = /\b[A-Z][A-Z0-9-]*-\d{3}\b/g;

export interface ResolvedAgentTeamProjectFile {
  absolutePath: string;
  relativePath: string;
}

export interface LoadedAgentTeamAcceptanceCases {
  sourceFilePath: string;
  cases: AgentTeamAcceptanceCase[];
}

interface ParsedMarkdownCase {
  id: string;
  title: string;
  heading: string;
  bodyLines: string[];
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
  const resolvedPath = await realpath(candidatePath).catch(() => null);
  if (!resolvedPath) {
    throw new AgentTeamError(400, `${label}不存在：${trimmedPath}`);
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

export async function loadAcceptanceCasesFromMarkdown(params: {
  projectRoot: string;
  requestedPath: string;
}): Promise<LoadedAgentTeamAcceptanceCases> {
  const resolved = await resolveAgentTeamProjectFile(
    params.projectRoot,
    params.requestedPath,
    "测试案例文件",
  );
  const markdown = await readFile(resolved.absolutePath, "utf8");
  const parsedCases = parseMarkdownCases(markdown);
  if (parsedCases.length === 0) {
    throw new AgentTeamError(
      400,
      `缺少可追溯测试案例文件：${resolved.relativePath} 未解析到三级标题 case ID`,
    );
  }
  return {
    sourceFilePath: resolved.relativePath,
    cases: parsedCases.map((item) =>
      buildAcceptanceCase(item, resolved.relativePath),
    ),
  };
}

function parseMarkdownCases(markdown: string): ParsedMarkdownCase[] {
  const cases: ParsedMarkdownCase[] = [];
  let current: ParsedMarkdownCase | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = CASE_HEADING_PATTERN.exec(line);
    if (heading) {
      if (current) {
        cases.push(current);
      }
      const id = heading[1]!;
      const title = heading[2]?.trim() || id;
      current = {
        id,
        title,
        heading: line.trim(),
        bodyLines: [],
      };
      continue;
    }
    if (current && /^##\s+/.test(line)) {
      cases.push(current);
      current = null;
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    cases.push(current);
  }
  return cases;
}

function buildAcceptanceCase(
  item: ParsedMarkdownCase,
  sourceFilePath: string,
): AgentTeamAcceptanceCase {
  const sections = extractSections(item.bodyLines);
  const missingSections = [
    sections.steps.length === 0 ? "步骤" : null,
    sections.expectations.length === 0 ? "期望" : null,
    sections.failures.length === 0 ? "失败判定" : null,
  ].filter((section): section is string => Boolean(section));
  if (missingSections.length > 0) {
    throw new AgentTeamError(
      400,
      `缺少可追溯测试案例文件：${sourceFilePath} 的 ${item.id} 缺少${missingSections.join("、")}`,
    );
  }
  const steps = summarizeLines(sections.steps);
  const expectations = summarizeLines(sections.expectations);
  const failures = summarizeLines(sections.failures);
  const dependsOn = extractCaseIds(sections.dependencies.join(" "));
  return {
    caseId: item.id,
    sourceCaseId: item.id,
    sourceFilePath,
    sourceHeading: item.heading,
    tags: extractTags(sections.tags.join(" ")),
    dependsOn,
    text: [
      `标题：${item.title}`,
      `步骤：${steps || "未填写"}`,
      `期望：${expectations || "未填写"}`,
      `失败判定：${failures || "未填写"}`,
    ].join("\n"),
    status: "pending",
    consecutiveFail: 0,
    evidence: [],
    bouncedToPanelId: null,
    recheckRequestedAt: null,
    recheckWorkerPanelId: null,
    recheckWorkerRole: null,
    recheckOutboxMtimeMs: null,
    recheckAttempt: 0,
    lastRunStatus: "pending",
    skipReason: null,
  };
}

function extractSections(lines: string[]): {
  steps: string[];
  expectations: string[];
  failures: string[];
  dependencies: string[];
  tags: string[];
} {
  const sections = {
    steps: [] as string[],
    expectations: [] as string[],
    failures: [] as string[],
    dependencies: [] as string[],
    tags: [] as string[],
  };
  let current: keyof typeof sections | null = null;
  for (const line of lines) {
    const label = parseSectionLabel(line);
    if (label) {
      current = label.key;
      if (label.rest) {
        sections[current].push(label.rest);
      }
      continue;
    }
    if (current) {
      sections[current].push(line);
    }
  }
  return {
    steps: cleanMarkdownLines(sections.steps),
    expectations: cleanMarkdownLines(sections.expectations),
    failures: cleanMarkdownLines(sections.failures),
    dependencies: cleanMarkdownLines(sections.dependencies),
    tags: cleanMarkdownLines(sections.tags),
  };
}

function parseSectionLabel(
  line: string,
): { key: "steps" | "expectations" | "failures" | "dependencies" | "tags"; rest: string } | null {
  const trimmed = line.trim();
  const match = /^(步骤|操作|期望|预期结果|失败判定|失败判断|依赖|标签)\s*[:：]?\s*(.*)$/.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }
  const label = match[1]!;
  const rest = match[2]?.trim() ?? "";
  if (label === "步骤" || label === "操作") {
    return { key: "steps", rest };
  }
  if (label === "期望" || label === "预期结果") {
    return { key: "expectations", rest };
  }
  if (label === "失败判定" || label === "失败判断") {
    return { key: "failures", rest };
  }
  if (label === "依赖") {
    return { key: "dependencies", rest };
  }
  return { key: "tags", rest };
}

function cleanMarkdownLines(lines: string[]): string[] {
  return lines
    .map((line) =>
      line
        .trim()
        .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/`([^`]+)`/g, "$1")
        .trim(),
    )
    .filter(Boolean);
}

function summarizeLines(lines: string[]): string {
  return lines.join("；").replace(/\s+/g, " ").trim().slice(0, 600);
}

function extractCaseIds(text: string): string[] {
  return Array.from(new Set(text.match(CASE_ID_PATTERN) ?? []));
}

function extractTags(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}
