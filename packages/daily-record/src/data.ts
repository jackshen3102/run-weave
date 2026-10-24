import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DailyManifest,
  DailyMaterial,
} from "@runweave/shared/daily-record";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function dates(from: string, to: string): string[] {
  for (const value of [from, to]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new Error(`日期无效：${value}`);
  }
  const length = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (length < 1 || length > 366)
    throw new Error("日期范围须为 1–366 天，to 包含在范围内");
  return Array.from({ length }, (_, index) =>
    new Date(Date.parse(from) + index * 86400000).toISOString().slice(0, 10),
  );
}

export function dayFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (timestamp: string): string => {
    if (!Number.isFinite(Date.parse(timestamp)))
      throw new Error("消息时间无效");
    const parts = formatter.formatToParts(new Date(timestamp));
    return ["year", "month", "day"]
      .map((key) => parts.find((part) => part.type === key)!.value)
      .join("-");
  };
}

/** New directories only: a failed run never replaces an earlier successful output. */
export async function publishDirectory(
  out: string,
  files: Record<string, string>,
) {
  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  // Reserve the destination exclusively; no overwriting existing user output.
  await mkdir(out, { mode: 0o700 });
  const temporary = `${out}.pending-${randomUUID()}`;
  try {
    await mkdir(temporary, { mode: 0o700 });
    for (const [name, content] of Object.entries(files)) {
      if (path.basename(name) !== name)
        throw new Error("产物必须位于输出目录内");
      const handle = await open(path.join(temporary, name), "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rename(temporary, out);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}

export async function loadBundle(directory: string) {
  const manifest: DailyManifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    dates(manifest.from, manifest.to).join() !== manifest.days.join()
  )
    throw new Error("材料包日期或版本无效");
  dayFormatter(manifest.timeZone);
  const text = await readFile(path.join(directory, "materials.jsonl"), "utf8");
  if (hash(text) !== manifest.materialsSha256)
    throw new Error("材料文件摘要不匹配");
  const materials: DailyMaterial[] = text.trim()
    ? text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  const ids = new Set<string>();
  const dayAt = dayFormatter(manifest.timeZone);
  for (const material of materials) {
    if (
      !material.id ||
      ids.has(material.id) ||
      hash(material.text) !== material.textSha256 ||
      material.day !== dayAt(material.occurredAt) ||
      !manifest.days.includes(material.day)
    )
      throw new Error("材料身份、日期或内容校验失败");
    ids.add(material.id);
  }
  return { manifest, materials };
}
