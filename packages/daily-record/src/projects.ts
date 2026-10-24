import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DailyMaterial,
  DailyProject,
} from "@runweave/shared/daily-record";

const exec = promisify(execFile);
export const unclassified: DailyProject = {
  id: "unclassified",
  name: "未归类",
};

export function validProject(value: unknown): value is DailyProject {
  if (!value || typeof value !== "object") return false;
  const project = value as DailyProject;
  return (
    typeof project.id === "string" &&
    (project.id === unclassified.id ||
      (project.id.startsWith("git:") &&
        path.isAbsolute(project.id.slice(4)))) &&
    typeof project.name === "string" &&
    !!project.name.trim() &&
    project.name.length <= 120 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(project.name) &&
    (project.id !== unclassified.id || project.name === unclassified.name)
  );
}

async function projectAt(cwd: string): Promise<DailyProject> {
  if (!cwd || !path.isAbsolute(cwd)) return { ...unclassified };
  // Ambient Git overrides must not change the repository identified by the source cwd.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  try {
    const { stdout } = await exec(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: 3000, maxBuffer: 65536, env },
    );
    const common = await realpath(stdout.trim());
    const name = path.basename(
      path.basename(common) === ".git" ? path.dirname(common) : common,
    );
    const project = { id: `git:${common}`, name };
    return validProject(project) ? project : { ...unclassified };
  } catch {
    return { ...unclassified };
  }
}

/** Freeze project identity in new bundles; resolve cwd only for older bundles. */
export async function assignProjects(materials: DailyMaterial[]) {
  const byCwd = new Map<string, Promise<DailyProject>>();
  for (const material of materials) {
    if (material.project !== undefined) {
      if (!validProject(material.project)) throw new Error("材料项目字段无效");
      continue;
    }
    let project = byCwd.get(material.cwd);
    if (!project) {
      project = projectAt(material.cwd);
      byCwd.set(material.cwd, project);
    }
    material.project = { ...(await project) };
  }
}

export function projectFor(sources: DailyMaterial[]): DailyProject {
  const projects = sources.map((source) => source.project ?? unclassified);
  const first = projects[0] ?? unclassified;
  return projects.every((project) => project.id === first.id)
    ? { ...first }
    : { ...unclassified };
}
