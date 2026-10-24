import { readFile } from "node:fs/promises";
import type {
  DailyFacts,
  DailyMaterial,
  DailyManifest,
  DailyProject,
} from "@runweave/shared/daily-record";
import { publishDirectory } from "./data.js";
import { projectFor, unclassified, validProject } from "./projects.js";

export async function readFacts(
  file: string,
  manifest: DailyManifest,
  materials: DailyMaterial[],
): Promise<DailyFacts> {
  const facts = JSON.parse(await readFile(file, "utf8")) as DailyFacts;
  if (
    facts.schemaVersion !== 1 ||
    facts.collectionId !== manifest.collectionId ||
    !Array.isArray(facts.days)
  )
    throw new Error("事实版本或材料包身份不匹配");
  if (facts.days.map((day) => day.date).join() !== manifest.days.join())
    throw new Error("事实文件必须按顺序包含范围内每一天；空日使用 items: []");
  const byId = new Map(materials.map((item) => [item.id, item]));
  const names = new Map<string, string>();
  for (const day of facts.days) {
    if (!Array.isArray(day.items))
      throw new Error(`${day.date}: items 必须是数组`);
    for (const fact of day.items) {
      if (
        typeof fact.statement !== "string" ||
        !fact.statement.trim() ||
        fact.statement.length > 4000 ||
        !["discussed", "attempted", "changed", "verified", "reported"].includes(
          fact.action,
        ) ||
        !Array.isArray(fact.sourceIds) ||
        !fact.sourceIds.length ||
        fact.sourceIds.some((id) => !byId.has(id))
      )
        throw new Error(`${day.date}: 事实缺少有效正文、动作或来源`);
      const sources = fact.sourceIds.map((id) => byId.get(id)!);
      if (!sources.some((source) => source.day === day.date))
        throw new Error(`${day.date}: 没有当天的来源依据`);
      if (
        fact.action === "verified" &&
        !sources.some(
          (source) => source.role === "tool" && source.day === day.date,
        )
      )
        throw new Error(`${day.date}: verified 必须引用当天的工具回执`);
      const inferred = projectFor(sources);
      if (fact.project !== undefined) {
        if (!validProject(fact.project) || fact.project.id !== inferred.id)
          throw new Error(`${day.date}: 项目无效或与来源仓库不一致`);
        const name = fact.project.name.trim();
        if (names.has(inferred.id) && names.get(inferred.id) !== name)
          throw new Error(`${day.date}: 同一项目不能使用不同名称`);
        names.set(inferred.id, name);
      }
      fact.project = fact.project ?? inferred;
    }
  }
  for (const day of facts.days)
    for (const fact of day.items)
      fact.project = {
        ...fact.project!,
        name: names.get(fact.project!.id) ?? fact.project!.name,
      };
  return facts;
}

export async function render(
  out: string,
  facts: DailyFacts,
  manifest: DailyManifest,
) {
  const complete = manifest.sources.every(
    (source) => source.status === "complete",
  );
  const files: Record<string, string> = {};
  const days = facts.days.map((day) => {
    const groups = new Map<
      string,
      { project: DailyProject; lines: string[] }
    >();
    for (const fact of day.items) {
      const project = fact.project ?? unclassified;
      const group = groups.get(project.id) ?? { project, lines: [] };
      const label = fact.action === "reported" ? "Agent 报告：" : "";
      group.lines.push(`- ${label}${fact.statement.trim()}`);
      groups.set(project.id, group);
    }
    const projectBody = (level: number) =>
      [...groups.values()]
        .map(({ project, lines }) => {
          const name = project.name.replace(/[\\`*_{}[\]()#+.!>|]/g, "\\$&");
          return `${"#".repeat(level)} ${name}\n\n${lines.join("\n\n")}`;
        })
        .join("\n\n");
    const body = (level: number) =>
      groups.size
        ? `${complete ? "" : "记录读取不完整，以下仅列已取得的记录。\n\n"}${projectBody(level)}`
        : complete
          ? "没有。"
          : "记录读取不完整，不能确认是否没有事项。";
    files[`${day.date}.md`] = `# ${day.date}\n\n${body(2)}\n`;
    return `## ${day.date}\n\n${body(3)}`;
  });
  files["weekly.md"] =
    `# 每日工作总结\n\n${manifest.from} 至 ${manifest.to} · ${manifest.timeZone}\n\n${days.join("\n\n")}\n`;
  files["facts.json"] = `${JSON.stringify(facts, null, 2)}\n`;
  files["manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  await publishDirectory(out, files);
  return {
    report: `${out}/weekly.md`,
    days: facts.days.length,
    facts: facts.days.reduce((count, day) => count + day.items.length, 0),
    complete,
  };
}
