import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  HANDOFF_MAX_PLAN_FILES,
  type HandoffPlanFileCandidate,
} from "@runweave/shared/terminal/context-handoff";
import { TerminalPanelError } from "./panel-common";

const RECENT_PLAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MENTIONED_PATH_PATTERN =
  /(?:file:\/\/)?(?:\/[^\s`"'()<>[\]，。；：！？（）【】]+\.md|(?:\.\/)?(?:docs\/plans|\.runweave\/handoffs)\/[^\s`"'()<>[\]，。；：！？（）【】]+\.md|[\w./-]*plan[\w./-]*\.md)(?:#[A-Za-z0-9._-]+)?/gi;

function isWithinRoot(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target !== root && target.startsWith(prefix);
}

function normalizeMentionedToken(raw: string): string {
  let token = raw.trim();
  if (token.startsWith("file://")) {
    token = token.slice("file://".length);
  }
  const hashIndex = token.indexOf("#");
  if (hashIndex >= 0) {
    token = token.slice(0, hashIndex);
  }
  token = token.replace(/[),.;:!?\]>'"]+$/g, "");
  return token;
}

async function resolveExistingPlanFile(
  rootReal: string,
  candidatePath: string,
  source: HandoffPlanFileCandidate["source"],
): Promise<HandoffPlanFileCandidate | null> {
  const cleaned = normalizeMentionedToken(candidatePath);
  if (!cleaned || cleaned.includes("\0") || !cleaned.toLowerCase().endsWith(".md")) {
    return null;
  }
  const resolved = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(rootReal, cleaned);
  if (!isWithinRoot(rootReal, resolved)) {
    return null;
  }
  try {
    const real = await realpath(resolved);
    if (!isWithinRoot(rootReal, real)) {
      return null;
    }
    const info = await stat(real);
    if (!info.isFile()) {
      return null;
    }
    const relativePath = path.relative(rootReal, real).split(path.sep).join("/");
    return {
      relativePath,
      absolutePath: real,
      sizeBytes: info.size,
      source,
    };
  } catch {
    return null;
  }
}

export async function detectPlanFiles(
  cwd: string,
  sourceText: string,
): Promise<HandoffPlanFileCandidate[]> {
  let rootReal: string;
  try {
    rootReal = await realpath(cwd);
  } catch {
    return [];
  }

  const results: HandoffPlanFileCandidate[] = [];
  const seen = new Set<string>();

  const matches = Array.from(sourceText.matchAll(MENTIONED_PATH_PATTERN)).map(
    (match) => match[0],
  );
  for (let index = matches.length - 1; index >= 0; index--) {
    if (results.length >= HANDOFF_MAX_PLAN_FILES) break;
    const candidate = await resolveExistingPlanFile(
      rootReal,
      matches[index]!,
      "mentioned",
    );
    if (!candidate || seen.has(candidate.absolutePath)) continue;
    seen.add(candidate.absolutePath);
    results.push(candidate);
  }

  if (results.length < HANDOFF_MAX_PLAN_FILES) {
    const plansDir = path.join(rootReal, "docs", "plans");
    try {
      const entries = await readdir(plansDir, { withFileTypes: true });
      const now = Date.now();
      const recent: { file: HandoffPlanFileCandidate; mtimeMs: number }[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
          continue;
        }
        const full = path.join(plansDir, entry.name);
        try {
          const real = await realpath(full);
          if (!isWithinRoot(rootReal, real) || seen.has(real)) continue;
          const info = await stat(real);
          if (!info.isFile() || now - info.mtimeMs > RECENT_PLAN_WINDOW_MS) {
            continue;
          }
          recent.push({
            mtimeMs: info.mtimeMs,
            file: {
              relativePath: path.relative(rootReal, real).split(path.sep).join("/"),
              absolutePath: real,
              sizeBytes: info.size,
              source: "recent_plan",
            },
          });
        } catch {
          // Ignore unreadable or vanishing entries in docs/plans.
        }
      }
      recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of recent) {
        if (results.length >= HANDOFF_MAX_PLAN_FILES) break;
        if (seen.has(item.file.absolutePath)) continue;
        seen.add(item.file.absolutePath);
        results.push(item.file);
      }
    } catch {
      // docs/plans does not exist or is unreadable.
    }
  }

  return results;
}

export async function validatePlanFilePaths(
  cwd: string,
  relativePaths: readonly string[],
): Promise<HandoffPlanFileCandidate[]> {
  if (!relativePaths.length) return [];
  if (relativePaths.length > HANDOFF_MAX_PLAN_FILES) {
    throw new TerminalPanelError(
      400,
      `最多只能关联 ${HANDOFF_MAX_PLAN_FILES} 份计划文件`,
    );
  }
  const rootReal = await realpath(cwd).catch(() => {
    throw new TerminalPanelError(404, "来源项目目录不可用");
  });

  const validated: HandoffPlanFileCandidate[] = [];
  const seen = new Set<string>();
  for (const rawPath of relativePaths) {
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("\0")) {
      throw new TerminalPanelError(400, "计划文件路径无效");
    }
    if (path.isAbsolute(trimmed)) {
      throw new TerminalPanelError(403, "计划文件路径必须为当前项目目录内的相对路径");
    }
    const resolved = path.resolve(rootReal, trimmed);
    if (!isWithinRoot(rootReal, resolved)) {
      throw new TerminalPanelError(403, "计划文件路径不能越出当前项目目录");
    }
    let real: string;
    try {
      real = await realpath(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TerminalPanelError(400, `计划文件不存在：${trimmed}`);
      }
      throw new TerminalPanelError(400, `无法读取计划文件：${trimmed}`);
    }
    if (!isWithinRoot(rootReal, real)) {
      throw new TerminalPanelError(403, "计划文件路径不能指向当前项目目录之外");
    }
    const info = await stat(real);
    if (!info.isFile()) {
      throw new TerminalPanelError(400, `计划路径不是普通文件：${trimmed}`);
    }
    if (seen.has(real)) continue;
    seen.add(real);
    validated.push({
      relativePath: path.relative(rootReal, real).split(path.sep).join("/"),
      absolutePath: real,
      sizeBytes: info.size,
      source: "mentioned",
    });
  }
  return validated;
}
